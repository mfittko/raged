import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  mergeAndRerankGraphResults,
  hybridMetadataFlow,
  hybridGraphFlow,
  extractEntityNamesFromResults,
} from "./hybrid-strategy.js";
import type { GraphPoolEntry, SeedPoolEntry, HybridMetadataRequest, HybridGraphRequest } from "./hybrid-strategy.js";
import type { QueryResultItem } from "./query.js";
import type {
  GraphBackend,
  TraversalResult,
  ResolvedEntity,
  EntityDocument,
} from "./graph-backend.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeItem(id: string, score: number, payload?: Record<string, unknown>): QueryResultItem {
  return { id, score, source: "test.txt", text: `text-${id}`, payload };
}

function makeGraphEntry(id: string, semanticScore: number, mentionCount: number): GraphPoolEntry {
  return { item: makeItem(id, semanticScore), semanticScore, mentionCount };
}

function makeSeedEntry(id: string, semanticScore: number): SeedPoolEntry {
  return { item: makeItem(id, semanticScore), semanticScore };
}

const defaultRerankRow = {
  chunk_id: "chunk-uuid-1:0",
  /** document_id is documents.id — distinct from the chunk UUID in chunk_id */
  document_id: "doc-uuid-1",
  distance: 0.1,
  text: "text",
  source: "src.txt",
  chunk_index: 0,
  base_id: "base-1",
  doc_type: "text",
  repo_id: null,
  repo_url: null,
  path: null,
  lang: null,
  item_url: null,
  tier1_meta: null,
  tier2_meta: null,
  tier3_meta: null,
  doc_summary: null,
  doc_summary_short: null,
  doc_summary_medium: null,
  doc_summary_long: null,
  payload_checksum: null,
};

const defaultTraversalResult: TraversalResult = {
  entities: [{ id: "e1", name: "EntityA", type: "service", depth: 0, isSeed: true }],
  relationships: [],
  paths: [],
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
    resolveEntities: vi.fn(async (names: string[]): Promise<ResolvedEntity[]> =>
      names.map((n) => ({ id: `id-${n}`, name: n, type: "service", requestedName: n })),
    ),
    traverse: vi.fn(async () => defaultTraversalResult),
    getEntityDocuments: vi.fn(async (): Promise<EntityDocument[]> => []),
    getEntity: vi.fn(async () => null),
    getEntityRelationships: vi.fn(async () => []),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mock modules
// ---------------------------------------------------------------------------

vi.mock("../db.js", () => ({
  getPool: vi.fn(() => ({
    query: vi.fn(async () => ({ rows: [] })),
  })),
}));

vi.mock("../embeddings.js", () => ({
  embed: vi.fn(async (texts: string[]) => texts.map(() => Array(768).fill(0.1))),
}));

// ---------------------------------------------------------------------------
// mergeAndRerankGraphResults — unit tests
// ---------------------------------------------------------------------------

describe("mergeAndRerankGraphResults", () => {
  it("returns [] for empty inputs", () => {
    expect(mergeAndRerankGraphResults([], [], 5, 0)).toEqual([]);
  });

  it("scores graph-only chunks with blended formula, sorted descending", () => {
    const graphPool = [
      makeGraphEntry("a", 0.9, 5),
      makeGraphEntry("b", 0.7, 0),
    ];
    const results = mergeAndRerankGraphResults(graphPool, [], 10, 0);
    expect(results).toHaveLength(2);
    // a: 0.85*0.9 + 0.15*(5/10) = 0.765 + 0.075 = 0.840 (MENTION_CAP=10)
    expect(results[0].id).toBe("a");
    // b: 0.85*0.7 + 0.15*(0/10) = 0.595
    expect(results[1].id).toBe("b");
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  it("scores seed-only chunks with raw similarity", () => {
    const seedPool = [makeSeedEntry("x", 0.8), makeSeedEntry("y", 0.6)];
    const results = mergeAndRerankGraphResults([], seedPool, 10, 0);
    expect(results).toHaveLength(2);
    expect(results[0].id).toBe("x");
    expect(results[0].score).toBeCloseTo(0.8);
    expect(results[1].score).toBeCloseTo(0.6);
  });

  it("deduplicates: chunk in both pools gets graph pool blended score", () => {
    const graphPool = [makeGraphEntry("shared", 0.8, 5)];
    const seedPool = [makeSeedEntry("shared", 0.6)];
    const results = mergeAndRerankGraphResults(graphPool, seedPool, 10, 0);
    expect(results).toHaveLength(1);
    // Graph blended: 0.85*0.8 + 0.15*(5/10) = 0.68 + 0.075 = 0.755
    expect(results[0].score).toBeCloseTo(0.755);
  });

  it("enforces topK", () => {
    const seedPool = Array.from({ length: 10 }, (_, i) =>
      makeSeedEntry(`item-${i}`, 0.9 - i * 0.05),
    );
    const results = mergeAndRerankGraphResults([], seedPool, 5, 0);
    expect(results).toHaveLength(5);
  });

  it("clamps mention count to MENTION_CAP (10) → boost = 1.0", () => {
    const graphPool = [makeGraphEntry("capped", 0.5, 100)];
    const results = mergeAndRerankGraphResults(graphPool, [], 1, 0);
    expect(results[0].score).toBeCloseTo(0.85 * 0.5 + 0.15 * 1.0);
  });

  it("applies minScore filter", () => {
    const seedPool = [makeSeedEntry("high", 0.9), makeSeedEntry("low", 0.2)];
    const results = mergeAndRerankGraphResults([], seedPool, 10, 0.5);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("high");
  });
});

// ---------------------------------------------------------------------------
// extractEntityNamesFromResults
// ---------------------------------------------------------------------------

describe("extractEntityNamesFromResults", () => {
  it("extracts from tier2Meta entities", () => {
    const item = makeItem("a", 0.9, {
      tier2Meta: { entities: [{ text: "EntityA" }] },
    });
    expect(extractEntityNamesFromResults([item])).toEqual(["EntityA"]);
  });

  it("extracts from tier3Meta entities", () => {
    const item = makeItem("a", 0.9, {
      tier3Meta: { entities: [{ name: "EntityB" }] },
    });
    expect(extractEntityNamesFromResults([item])).toEqual(["EntityB"]);
  });

  it("deduplicates case-insensitively", () => {
    const item = makeItem("a", 0.9, {
      tier2Meta: { entities: [{ text: "EntityA" }] },
      tier3Meta: { entities: [{ name: "entitya" }] },
    });
    expect(extractEntityNamesFromResults([item])).toHaveLength(1);
  });

  it("caps at 50 names", () => {
    const items = Array.from({ length: 60 }, (_, i) =>
      makeItem(`id-${i}`, 0.9, {
        tier2Meta: { entities: [{ text: `Entity${i}` }] },
      }),
    );
    expect(extractEntityNamesFromResults(items)).toHaveLength(50);
  });
});

// ---------------------------------------------------------------------------
// hybridMetadataFlow — Flow 1 integration tests
// ---------------------------------------------------------------------------

describe("hybridMetadataFlow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const baseRequest: HybridMetadataRequest = {
    collection: "docs",
    query: "test query",
    topK: 5,
    minScore: 0.3,
  };

  it("returns [] and does not call embed() when no candidates", async () => {
    const { getPool } = await import("../db.js");
    (getPool as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      query: vi.fn(async () => ({ rows: [] })),
    });
    const { embed } = await import("../embeddings.js");

    const result = await hybridMetadataFlow(baseRequest);

    expect(result.ok).toBe(true);
    expect(result.results).toEqual([]);
    expect(embed).not.toHaveBeenCalled();
  });

  it("calls embed() exactly once when candidates exist", async () => {
    const { getPool } = await import("../db.js");
    const queryMock = vi.fn()
      .mockResolvedValueOnce({ rows: [{ chunk_uuid: "uuid-1" }] }) // Phase 1
      .mockResolvedValueOnce({ rows: [{ ...defaultRerankRow, distance: 0.2 }] }); // Phase 2
    (getPool as ReturnType<typeof vi.fn>).mockReturnValueOnce({ query: queryMock });

    const { embed } = await import("../embeddings.js");

    await hybridMetadataFlow(baseRequest);

    expect(embed).toHaveBeenCalledTimes(1);
  });

  it("happy path: returns results sorted by similarity", async () => {
    const { getPool } = await import("../db.js");
    const queryMock = vi.fn()
      .mockResolvedValueOnce({ rows: [{ chunk_uuid: "uuid-1" }, { chunk_uuid: "uuid-2" }] })
      .mockResolvedValueOnce({
        rows: [
          { ...defaultRerankRow, chunk_id: "chunk-uuid-1:0", distance: 0.1 },
          { ...defaultRerankRow, chunk_id: "chunk-uuid-2:0", distance: 0.3 },
        ],
      });
    (getPool as ReturnType<typeof vi.fn>).mockReturnValueOnce({ query: queryMock });

    const result = await hybridMetadataFlow({ ...baseRequest, minScore: 0 });

    expect(result.ok).toBe(true);
    expect(result.results).toHaveLength(2);
    expect(result.results[0].score).toBeGreaterThan(result.results[1].score);
  });

  it("applies minScore filter to final results", async () => {
    const { getPool } = await import("../db.js");
    const queryMock = vi.fn()
      .mockResolvedValueOnce({ rows: [{ chunk_uuid: "uuid-1" }] })
      .mockResolvedValueOnce({
        rows: [{ ...defaultRerankRow, chunk_id: "chunk-uuid-1:0", distance: 0.8 }],
      });
    (getPool as ReturnType<typeof vi.fn>).mockReturnValueOnce({ query: queryMock });

    // score = 1 - 0.8 = 0.2; minScore = 0.5 → should be excluded
    const result = await hybridMetadataFlow({ ...baseRequest, minScore: 0.5 });

    expect(result.results).toHaveLength(0);
  });

  it("candidate limit is min(topK * 5, 500)", async () => {
    const { getPool } = await import("../db.js");
    const queryMock = vi.fn().mockResolvedValue({ rows: [] });
    (getPool as ReturnType<typeof vi.fn>).mockReturnValueOnce({ query: queryMock });

    await hybridMetadataFlow({ ...baseRequest, topK: 200 }); // 200*5=1000 → capped at 500

    const firstCallArgs = queryMock.mock.calls[0] as unknown[];
    const params = firstCallArgs[1] as unknown[];
    expect(params[1]).toBe(500); // candidateLimit = $2
  });
});

// ---------------------------------------------------------------------------
// hybridGraphFlow — Flow 2 integration tests
// ---------------------------------------------------------------------------

describe("hybridGraphFlow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const baseRequest: HybridGraphRequest = {
    collection: "docs",
    query: "test query",
    topK: 5,
    minScore: 0,
  };

  const seedRow = {
    ...defaultRerankRow,
    chunk_id: "seed-chunk-uuid:0",
    document_id: "seed-doc-uuid",
    distance: 0.15,
    tier2_meta: { entities: [{ text: "EntityA" }] },
  };

  const graphRow = {
    ...defaultRerankRow,
    chunk_id: "graph-chunk-uuid:0",
    // document_id is distinct from chunk UUID — this is documents.id, not chunks.id
    document_id: "graph-doc-uuid",
    distance: 0.1,
  };

  it("calls embed() exactly once", async () => {
    const { getPool } = await import("../db.js");
    const queryMock = vi.fn()
      .mockResolvedValueOnce({ rows: [seedRow] })   // seed search
      .mockResolvedValueOnce({ rows: [graphRow] }); // rerank
    (getPool as ReturnType<typeof vi.fn>).mockReturnValueOnce({ query: queryMock });

    const backend = makeBackend({
      getEntityDocuments: vi.fn(async (): Promise<EntityDocument[]> => [
        { documentId: "graph-doc-uuid", source: "src.txt", entityName: "EntityA", mentionCount: 3 },
      ]),
    });

    const { embed } = await import("../embeddings.js");
    await hybridGraphFlow(baseRequest, backend);

    expect(embed).toHaveBeenCalledTimes(1);
  });

  it("happy path: returns merged results with graph field populated", async () => {
    const { getPool } = await import("../db.js");
    const queryMock = vi.fn()
      .mockResolvedValueOnce({ rows: [seedRow] })
      .mockResolvedValueOnce({ rows: [graphRow] });
    (getPool as ReturnType<typeof vi.fn>).mockReturnValueOnce({ query: queryMock });

    const backend = makeBackend({
      getEntityDocuments: vi.fn(async (): Promise<EntityDocument[]> => [
        { documentId: "graph-doc-uuid", source: "src.txt", entityName: "EntityA", mentionCount: 3 },
      ]),
    });

    const result = await hybridGraphFlow(baseRequest, backend);

    expect(result.ok).toBe(true);
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.graph).toBeDefined();
    expect(result.graph?.entities).toHaveLength(1);
  });

  it("falls back to seed results when no entity names extracted", async () => {
    const { getPool } = await import("../db.js");
    // seed row with no entity metadata
    const emptyMetaRow = { ...defaultRerankRow, chunk_id: "seed-chunk-uuid:0", distance: 0.2 };
    const queryMock = vi.fn().mockResolvedValueOnce({ rows: [emptyMetaRow] });
    (getPool as ReturnType<typeof vi.fn>).mockReturnValueOnce({ query: queryMock });

    const backend = makeBackend();

    const result = await hybridGraphFlow(baseRequest, backend);

    expect(result.ok).toBe(true);
    expect(result.results).toHaveLength(1);
    expect(backend.resolveEntities).not.toHaveBeenCalled();
    expect(backend.traverse).not.toHaveBeenCalled();
    // graph field is populated with empty result + warning
    expect(result.graph).toBeDefined();
    expect(result.graph?.entities).toHaveLength(0);
    expect(result.graph?.meta.warnings).toContain("No entities found in seed results to seed the graph");
  });

  it("falls back to seed results when getEntityDocuments returns empty", async () => {
    const { getPool } = await import("../db.js");
    const queryMock = vi.fn()
      .mockResolvedValueOnce({ rows: [seedRow] })
      .mockResolvedValueOnce({ rows: [] }); // rerank (never reached due to fallback)
    (getPool as ReturnType<typeof vi.fn>).mockReturnValueOnce({ query: queryMock });

    const backend = makeBackend(); // getEntityDocuments returns []

    const result = await hybridGraphFlow(baseRequest, backend);

    expect(result.ok).toBe(true);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].id).toBe("seed-chunk-uuid:0");
    // graph field is still populated from traversal
    expect(result.graph).toBeDefined();
  });

  it("overlapping chunk gets graph pool blended score (deduplication)", async () => {
    const { getPool } = await import("../db.js");
    // seed and graph share the same chunk id
    const sharedChunkId = "shared-chunk-uuid:0";
    // document_id is distinct from chunk UUID — as it would be in the real schema
    const sharedDocId = "shared-doc-uuid";
    const sharedSeedRow = {
      ...defaultRerankRow,
      chunk_id: sharedChunkId,
      document_id: sharedDocId,
      distance: 0.3, // semanticScore = 0.7
      tier2_meta: { entities: [{ text: "EntityA" }] },
    };
    const sharedGraphRow = {
      ...defaultRerankRow,
      chunk_id: sharedChunkId,
      document_id: sharedDocId,
      distance: 0.3, // semanticScore = 0.7
    };

    const queryMock = vi.fn()
      .mockResolvedValueOnce({ rows: [sharedSeedRow] })
      .mockResolvedValueOnce({ rows: [sharedGraphRow] });
    (getPool as ReturnType<typeof vi.fn>).mockReturnValueOnce({ query: queryMock });

    const backend = makeBackend({
      getEntityDocuments: vi.fn(async (): Promise<EntityDocument[]> => [
        // documentId = sharedDocId (documents.id), NOT derived from chunk_id
        { documentId: sharedDocId, source: "src.txt", entityName: "EntityA", mentionCount: 5 },
      ]),
    });

    const result = await hybridGraphFlow(baseRequest, backend);

    const item = result.results.find((r) => r.id === sharedChunkId);
    expect(item).toBeDefined();
    // Blended score: 0.85*0.7 + 0.15*(5/10) = 0.595 + 0.075 = 0.67
    expect(item!.score).toBeCloseTo(0.85 * 0.7 + 0.15 * (5 / 10));
  });

  it("result count never exceeds topK", async () => {
    const { getPool } = await import("../db.js");
    const manyRows = Array.from({ length: 15 }, (_, i) => ({
      ...defaultRerankRow,
      chunk_id: `seed-chunk-${i}:0`,
      document_id: `seed-doc-${i}`,
      distance: 0.1 + i * 0.01,
      tier2_meta: { entities: [{ text: "EntityA" }] },
    }));
    const graphRows = Array.from({ length: 10 }, (_, i) => ({
      ...defaultRerankRow,
      chunk_id: `graph-chunk-${i}:0`,
      document_id: `graph-doc-${i}`,
      distance: 0.2 + i * 0.01,
    }));

    const queryMock = vi.fn()
      .mockResolvedValueOnce({ rows: manyRows })
      .mockResolvedValueOnce({ rows: graphRows });
    (getPool as ReturnType<typeof vi.fn>).mockReturnValueOnce({ query: queryMock });

    const backend = makeBackend({
      getEntityDocuments: vi.fn(async (): Promise<EntityDocument[]> =>
        graphRows.map((r) => ({
          documentId: r.document_id,
          source: "src.txt",
          entityName: "EntityA",
          mentionCount: 1,
        })),
      ),
    });

    const result = await hybridGraphFlow({ ...baseRequest, topK: 5 }, backend);
    expect(result.results.length).toBeLessThanOrEqual(5);
  });
});

// ---------------------------------------------------------------------------
// Boundary tests
// ---------------------------------------------------------------------------

describe("hybrid strategy boundary tests", () => {
  it("topK=100 → candidateLimit = min(100*5, 500) = 500", async () => {
    vi.clearAllMocks();
    const { getPool } = await import("../db.js");
    const queryMock = vi.fn().mockResolvedValue({ rows: [] });
    (getPool as ReturnType<typeof vi.fn>).mockReturnValueOnce({ query: queryMock });

    await hybridMetadataFlow({
      collection: "docs",
      query: "q",
      topK: 100,
      minScore: 0,
    });

    const firstCallArgs = queryMock.mock.calls[0] as unknown[];
    const params = firstCallArgs[1] as unknown[];
    expect(params[1]).toBe(500);
  });

  it("weight invariant: module loads successfully, confirming SEMANTIC_WEIGHT + MENTION_WEIGHT = 1.0", async () => {
    // Dynamic import re-executes the module's top-level code (including the
    // invariant check). If the weights didn't sum to 1.0, the import would throw.
    const module = await import("./hybrid-strategy.js");
    expect(module.mergeAndRerankGraphResults).toBeDefined();
  });
});
