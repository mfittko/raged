import { describe, it, expect, vi } from "vitest";
import { executeGraphStrategy } from "./graph-strategy.js";
import type { GraphBackend, TraversalResult, ResolvedEntity } from "./graph-backend.js";
import type { QueryResultItem } from "./query.js";

function makeResult(tier2Entities: string[], tier3Entities: string[] = []): QueryResultItem {
  return {
    id: "chunk:0",
    score: 0.9,
    source: "test.txt",
    text: "hello",
    payload: {
      tier2Meta: tier2Entities.length ? { entities: tier2Entities.map((t) => ({ text: t })) } : null,
      tier3Meta: tier3Entities.length ? { entities: tier3Entities.map((n) => ({ name: n })) } : null,
    },
  };
}

const defaultTraversalResult: TraversalResult = {
  entities: [
    { id: "e1", name: "EntityA", type: "service", depth: 0, isSeed: true },
  ],
  relationships: [
    { source: "EntityA", target: "EntityB", type: "calls" },
  ],
  paths: [{ entities: ["EntityA"], relationships: [], depth: 0 }],
  documents: [],
  meta: {
    seedEntities: ["EntityA"],
    seedSource: "results",
    maxDepthUsed: 2,
    entityCount: 1,
    entityCap: 50,
    capped: false,
    timeLimitMs: 5000,
    timedOut: false,
    warnings: [],
  },
};

function makeBackend(overrides: Partial<GraphBackend> = {}): GraphBackend {
  return {
    resolveEntities: vi.fn(async (names: string[]) =>
      names.map((n) => ({ id: `id-${n}`, name: n, type: "service" })),
    ),
    traverse: vi.fn(async () => defaultTraversalResult),
    getEntityDocuments: vi.fn(async () => []),
    getEntity: vi.fn(async () => null),
    getEntityRelationships: vi.fn(async () => []),
    ...overrides,
  };
}

describe("executeGraphStrategy", () => {
  describe("seed extraction", () => {
    it("extracts seeds from tier2Meta entities", async () => {
      const backend = makeBackend();
      const results = [makeResult(["EntityA", "EntityB"])];
      await executeGraphStrategy({}, results, backend);
      expect(backend.resolveEntities).toHaveBeenCalledWith(["EntityA", "EntityB"]);
    });

    it("extracts seeds from tier3Meta entities", async () => {
      const backend = makeBackend();
      const results = [makeResult([], ["EntityC"])];
      await executeGraphStrategy({}, results, backend);
      expect(backend.resolveEntities).toHaveBeenCalledWith(["EntityC"]);
    });

    it("deduplicates seeds case-insensitively across tier2 and tier3", async () => {
      const backend = makeBackend();
      const results = [makeResult(["EntityA"], ["entitya"])];
      await executeGraphStrategy({}, results, backend);
      const called = (backend.resolveEntities as ReturnType<typeof vi.fn>).mock.calls[0][0] as string[];
      expect(called).toHaveLength(1);
    });

    it("uses explicit seedEntities when provided (D10)", async () => {
      const backend = makeBackend();
      const results = [makeResult(["EntityA"])];
      await executeGraphStrategy({ seedEntities: ["ExplicitSeed"] }, results, backend);
      expect(backend.resolveEntities).toHaveBeenCalledWith(["ExplicitSeed"]);
    });

    it("falls back to extraction when seedEntities is empty (D10)", async () => {
      const backend = makeBackend();
      const results = [makeResult(["EntityA"])];
      await executeGraphStrategy({ seedEntities: [] }, results, backend);
      expect(backend.resolveEntities).toHaveBeenCalledWith(["EntityA"]);
    });

    it("caps seed names at 50", async () => {
      const backend = makeBackend();
      const names = Array.from({ length: 60 }, (_, i) => `Entity${i}`);
      const results = [makeResult(names)];
      await executeGraphStrategy({}, results, backend);
      const called = (backend.resolveEntities as ReturnType<typeof vi.fn>).mock.calls[0][0] as string[];
      expect(called).toHaveLength(50);
    });
  });

  describe("degradation cases", () => {
    it("D1: returns empty graph with warning when no entities in results", async () => {
      const backend = makeBackend();
      const results: QueryResultItem[] = [makeResult([])];
      const result = await executeGraphStrategy({}, results, backend);
      expect(result).toBeDefined();
      expect(result!.entities).toHaveLength(0);
      expect(result!.meta.warnings.length).toBeGreaterThan(0);
      expect(backend.traverse).not.toHaveBeenCalled();
    });

    it("D2: returns empty graph with warning when no seeds resolve", async () => {
      const backend = makeBackend({
        resolveEntities: vi.fn(async () => [] as ResolvedEntity[]),
      });
      const results = [makeResult(["Unknown"])];
      const result = await executeGraphStrategy({}, results, backend);
      expect(result).toBeDefined();
      expect(result!.entities).toHaveLength(0);
      expect(result!.meta.warnings.some((w: string) => w.includes("None of the seed entities"))).toBe(true);
      expect(backend.traverse).not.toHaveBeenCalled();
    });

    it("D3: traverses with partial resolution, adds warnings for unresolved", async () => {
      const backend = makeBackend({
        resolveEntities: vi.fn(async () => [
          { id: "id-EntityA", name: "EntityA", type: "service" },
        ] as ResolvedEntity[]),
      });
      const results = [makeResult(["EntityA", "UnknownB"])];
      const result = await executeGraphStrategy({}, results, backend);
      expect(result).toBeDefined();
      expect(backend.traverse).toHaveBeenCalledWith(
        ["id-EntityA"],
        expect.any(Object),
      );
      expect(result!.meta.warnings.some((w: string) => w.includes("UnknownB"))).toBe(true);
    });

    it("D4: seeds only when no relationships", async () => {
      const backend = makeBackend({
        traverse: vi.fn(async () => ({
          ...defaultTraversalResult,
          relationships: [],
        })),
      });
      const results = [makeResult(["EntityA"])];
      const result = await executeGraphStrategy({}, results, backend);
      expect(result!.relationships).toHaveLength(0);
    });

    it("D5: passes through timedOut=true from traversal", async () => {
      const backend = makeBackend({
        traverse: vi.fn(async () => ({
          ...defaultTraversalResult,
          meta: { ...defaultTraversalResult.meta, timedOut: true },
        })),
      });
      const results = [makeResult(["EntityA"])];
      const result = await executeGraphStrategy({}, results, backend);
      expect(result!.meta.timedOut).toBe(true);
    });

    it("D6: passes through capped=true from traversal", async () => {
      const backend = makeBackend({
        traverse: vi.fn(async () => ({
          ...defaultTraversalResult,
          meta: { ...defaultTraversalResult.meta, capped: true },
        })),
      });
      const results = [makeResult(["EntityA"])];
      const result = await executeGraphStrategy({}, results, backend);
      expect(result!.meta.capped).toBe(true);
    });

    it("D7: returns empty documents array when no mentions", async () => {
      const backend = makeBackend({
        getEntityDocuments: vi.fn(async () => []),
      });
      const results = [makeResult(["EntityA"])];
      const result = await executeGraphStrategy({ includeDocuments: true }, results, backend);
      expect(result!.documents).toHaveLength(0);
    });

    it("D8: returns undefined and logs on traversal DB error", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const backend = makeBackend({
        traverse: vi.fn(async () => { throw new Error("DB connection error"); }),
      });
      const results = [makeResult(["EntityA"])];
      const result = await executeGraphStrategy({}, results, backend);
      expect(result).toBeUndefined();
      consoleSpy.mockRestore();
    });

    it("D9: returns undefined and logs on resolution DB error", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const backend = makeBackend({
        resolveEntities: vi.fn(async () => { throw new Error("DB connection error"); }),
      });
      const results = [makeResult(["EntityA"])];
      const result = await executeGraphStrategy({}, results, backend);
      expect(result).toBeUndefined();
      consoleSpy.mockRestore();
    });

    it("D10: falls back to extraction when seedEntities is empty array", async () => {
      const backend = makeBackend();
      const results = [makeResult(["FallbackEntity"])];
      await executeGraphStrategy({ seedEntities: [] }, results, backend);
      expect(backend.resolveEntities).toHaveBeenCalledWith(["FallbackEntity"]);
    });
  });

  describe("graph result assembly", () => {
    it("returns entities with depth and isSeed fields", async () => {
      const results = [makeResult(["EntityA"])];
      const backend = makeBackend();
      const result = await executeGraphStrategy({}, results, backend);
      expect(result!.entities[0]).toHaveProperty("depth");
      expect(result!.entities[0]).toHaveProperty("isSeed");
      expect(result!.entities[0].name).toBe("EntityA");
    });

    it("sets seedSource=explicit when seedEntities provided", async () => {
      const backend = makeBackend();
      const result = await executeGraphStrategy({ seedEntities: ["ExplicitSeed"] }, [], backend);
      expect(result!.meta.seedSource).toBe("explicit");
    });

    it("sets seedSource=results when extracted from results", async () => {
      const backend = makeBackend();
      const results = [makeResult(["EntityA"])];
      const result = await executeGraphStrategy({}, results, backend);
      expect(result!.meta.seedSource).toBe("results");
    });

    it("includes documents when includeDocuments=true", async () => {
      const backend = makeBackend({
        getEntityDocuments: vi.fn(async () => [
          { documentId: "doc-1", source: "test.txt", entityName: "EntityA", mentionCount: 2 },
        ]),
      });
      const results = [makeResult(["EntityA"])];
      const result = await executeGraphStrategy({ includeDocuments: true }, results, backend);
      expect(result!.documents).toHaveLength(1);
      expect(result!.documents[0].documentId).toBe("doc-1");
    });

    it("passes traversal params correctly", async () => {
      const backend = makeBackend();
      const results = [makeResult(["EntityA"])];
      await executeGraphStrategy(
        {
          maxDepth: 3,
          maxEntities: 100,
          relationshipTypes: ["calls", "uses"],
        },
        results,
        backend,
      );
      expect(backend.traverse).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({
          maxDepth: 3,
          maxEntities: 100,
          relationshipTypes: ["calls", "uses"],
          timeLimitMs: 5000,
        }),
      );
    });
  });
});
