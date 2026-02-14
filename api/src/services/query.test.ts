import { describe, it, expect, vi } from "vitest";
import { query } from "./query.js";
import type { QueryDeps, QueryRequest } from "./query.js";

function makeDeps(overrides?: Partial<QueryDeps>): QueryDeps {
  return {
    embed: overrides?.embed ?? vi.fn(async (texts: string[]) =>
      texts.map(() => [0.1, 0.2, 0.3])
    ),
    ensureCollection: overrides?.ensureCollection ?? vi.fn(async () => {}),
    search: overrides?.search ?? vi.fn(async () => []),
    collectionName: overrides?.collectionName ?? vi.fn((name?: string) => name || "docs"),
    expandEntities: overrides?.expandEntities,
  };
}

describe("query service", () => {
  it("ensures the collection exists before searching", async () => {
    const deps = makeDeps();
    const request: QueryRequest = {
      collection: "test-col",
      query: "hello",
    };

    await query(request, deps);

    expect(deps.ensureCollection).toHaveBeenCalledWith("test-col");
  });

  it("uses default collection when none specified", async () => {
    const deps = makeDeps();
    const request: QueryRequest = {
      query: "hello",
    };

    await query(request, deps);

    expect(deps.collectionName).toHaveBeenCalledWith(undefined);
  });

  it("embeds the query text", async () => {
    const embedMock = vi.fn(async (texts: string[]) =>
      texts.map(() => [0.1, 0.2, 0.3])
    );
    const deps = makeDeps({ embed: embedMock });
    const request: QueryRequest = {
      query: "what is this?",
    };

    await query(request, deps);

    expect(embedMock).toHaveBeenCalledWith(["what is this?"]);
  });

  it("uses default topK of 8 when not specified", async () => {
    const searchMock = vi.fn(async () => []);
    const deps = makeDeps({ search: searchMock });
    const request: QueryRequest = {
      query: "hello",
    };

    await query(request, deps);

    // searchMock called with (collection, vector, limit, filter)
    expect((searchMock.mock.calls[0] as any)?.[2]).toBe(8);
  });

  it("uses custom topK when specified", async () => {
    const searchMock = vi.fn(async () => []);
    const deps = makeDeps({ search: searchMock });
    const request: QueryRequest = {
      query: "hello",
      topK: 5,
    };

    await query(request, deps);

    expect((searchMock.mock.calls[0] as any)?.[2]).toBe(5);
  });

  it("passes filter to search", async () => {
    const searchMock = vi.fn(async () => []);
    const deps = makeDeps({ search: searchMock });
    const filter = { lang: "en" };
    const request: QueryRequest = {
      query: "hello",
      filter,
    };

    await query(request, deps);

    expect((searchMock.mock.calls[0] as any)?.[3]).toBe(filter);
  });

  it("returns results with correct structure", async () => {
    const searchMock = vi.fn(async () => [
      {
        id: "doc-1:0",
        score: 0.95,
        payload: { text: "hello world", source: "test.txt", chunkIndex: 0 },
      },
      {
        id: "doc-2:0",
        score: 0.85,
        payload: { text: "hello there", source: "other.txt", chunkIndex: 0 },
      },
    ]);
    const deps = makeDeps({ search: searchMock });
    const request: QueryRequest = {
      query: "hello",
    };

    const result = await query(request, deps);

    expect(result).toEqual({
      ok: true,
      results: [
        {
          id: "doc-1:0",
          score: 0.95,
          source: "test.txt",
          text: "hello world",
          payload: { text: "hello world", source: "test.txt", chunkIndex: 0 },
        },
        {
          id: "doc-2:0",
          score: 0.85,
          source: "other.txt",
          text: "hello there",
          payload: { text: "hello there", source: "other.txt", chunkIndex: 0 },
        },
      ],
    });
  });

  it("returns empty results when search finds nothing", async () => {
    const deps = makeDeps({ search: vi.fn(async () => []) });
    const request: QueryRequest = {
      query: "nonexistent",
    };

    const result = await query(request, deps);

    expect(result).toEqual({
      ok: true,
      results: [],
    });
  });

  it("handles search results without source or text in payload", async () => {
    const searchMock = vi.fn(async () => [
      {
        id: "doc-1:0",
        score: 0.95,
        payload: { someOtherField: "value" },
      },
    ]);
    const deps = makeDeps({ search: searchMock });
    const request: QueryRequest = {
      query: "hello",
    };

    const result = await query(request, deps);

    expect(result.results[0]).toEqual({
      id: "doc-1:0",
      score: 0.95,
      source: undefined,
      text: undefined,
      payload: { someOtherField: "value" },
    });
  });

  describe("graph expansion", () => {
    it("does not expand when graphExpand is false", async () => {
      const expandEntitiesMock = vi.fn(async () => []);
      const deps = makeDeps({
        search: vi.fn(async () => [
          {
            id: "doc-1:0",
            score: 0.9,
            payload: {
              text: "test",
              tier2: { entities: [{ text: "AuthService" }] },
            },
          },
        ]),
        expandEntities: expandEntitiesMock,
      });
      const request: QueryRequest = {
        query: "hello",
        graphExpand: false,
      };

      const result = await query(request, deps);

      expect(expandEntitiesMock).not.toHaveBeenCalled();
      expect(result.graph).toBeUndefined();
    });

    it("does not expand when expandEntities is not provided", async () => {
      const deps = makeDeps({
        search: vi.fn(async () => [
          {
            id: "doc-1:0",
            score: 0.9,
            payload: {
              text: "test",
              tier2: { entities: [{ text: "AuthService" }] },
            },
          },
        ]),
      });
      const request: QueryRequest = {
        query: "hello",
        graphExpand: true,
      };

      const result = await query(request, deps);

      expect(result.graph).toBeUndefined();
    });

    it("extracts entities from tier2Meta and expands", async () => {
      const expandEntitiesMock = vi.fn(async (names: string[]) => [
        { name: "JWT", type: "library" },
      ]);
      const deps = makeDeps({
        search: vi.fn(async () => [
          {
            id: "doc-1:0",
            score: 0.9,
            payload: {
              text: "test",
              tier2: { entities: [{ text: "AuthService" }, { text: "UserService" }] },
            },
          },
        ]),
        expandEntities: expandEntitiesMock,
      });
      const request: QueryRequest = {
        query: "hello",
        graphExpand: true,
      };

      const result = await query(request, deps);

      expect(expandEntitiesMock).toHaveBeenCalledWith(["AuthService", "UserService"], 2);
      expect(result.graph).toBeDefined();
      expect(result.graph?.entities).toHaveLength(3);
      expect(result.graph?.entities.map(e => e.name).sort()).toEqual(["AuthService", "JWT", "UserService"]);
    });

    it("extracts entities from tier3Meta and expands", async () => {
      const expandEntitiesMock = vi.fn(async () => [
        { name: "Database", type: "service" },
      ]);
      const deps = makeDeps({
        search: vi.fn(async () => [
          {
            id: "doc-1:0",
            score: 0.9,
            payload: {
              text: "test",
              tier3: { entities: [{ name: "API" }, { name: "Cache" }] },
            },
          },
        ]),
        expandEntities: expandEntitiesMock,
      });
      const request: QueryRequest = {
        query: "hello",
        graphExpand: true,
      };

      const result = await query(request, deps);

      expect(expandEntitiesMock).toHaveBeenCalledWith(["API", "Cache"], 2);
      expect(result.graph).toBeDefined();
      expect(result.graph?.entities).toHaveLength(3);
    });

    it("merges entities from tier2Meta and tier3Meta", async () => {
      const expandEntitiesMock = vi.fn(async () => []);
      const deps = makeDeps({
        search: vi.fn(async () => [
          {
            id: "doc-1:0",
            score: 0.9,
            payload: {
              text: "test",
              tier2: { entities: [{ text: "EntityA" }] },
              tier3: { entities: [{ name: "EntityB" }] },
            },
          },
        ]),
        expandEntities: expandEntitiesMock,
      });
      const request: QueryRequest = {
        query: "hello",
        graphExpand: true,
      };

      const result = await query(request, deps);

      expect(expandEntitiesMock).toHaveBeenCalledWith(["EntityA", "EntityB"], 2);
    });

    it("deduplicates entities across multiple results", async () => {
      const expandEntitiesMock = vi.fn(async () => []);
      const deps = makeDeps({
        search: vi.fn(async () => [
          {
            id: "doc-1:0",
            score: 0.9,
            payload: {
              text: "test",
              tier2: { entities: [{ text: "SharedEntity" }] },
            },
          },
          {
            id: "doc-2:0",
            score: 0.8,
            payload: {
              text: "test2",
              tier2: { entities: [{ text: "SharedEntity" }] },
            },
          },
        ]),
        expandEntities: expandEntitiesMock,
      });
      const request: QueryRequest = {
        query: "hello",
        graphExpand: true,
      };

      await query(request, deps);

      // Should only call with unique entity names
      expect(expandEntitiesMock).toHaveBeenCalledWith(["SharedEntity"], 2);
    });

    it("handles empty entity extraction", async () => {
      const expandEntitiesMock = vi.fn(async () => []);
      const deps = makeDeps({
        search: vi.fn(async () => [
          {
            id: "doc-1:0",
            score: 0.9,
            payload: { text: "test" },
          },
        ]),
        expandEntities: expandEntitiesMock,
      });
      const request: QueryRequest = {
        query: "hello",
        graphExpand: true,
      };

      const result = await query(request, deps);

      expect(expandEntitiesMock).not.toHaveBeenCalled();
      expect(result.graph).toBeUndefined();
    });

    it("builds graph with entity types from expanded results", async () => {
      const expandEntitiesMock = vi.fn(async () => [
        { name: "ExpandedEntity", type: "class" },
      ]);
      const deps = makeDeps({
        search: vi.fn(async () => [
          {
            id: "doc-1:0",
            score: 0.9,
            payload: {
              text: "test",
              tier2: { entities: [{ text: "OriginalEntity" }] },
            },
          },
        ]),
        expandEntities: expandEntitiesMock,
      });
      const request: QueryRequest = {
        query: "hello",
        graphExpand: true,
      };

      const result = await query(request, deps);

      expect(result.graph?.entities).toEqual([
        { name: "OriginalEntity", type: "unknown" },
        { name: "ExpandedEntity", type: "class" },
      ]);
    });
  });
});
