import { describe, it, expect, vi, beforeEach } from "vitest";
import { SqlGraphBackend } from "./sql-graph-backend.js";

function makePool(responses: { rows: unknown[] }[]) {
  const queryMock = vi.fn();
  for (const r of responses) {
    queryMock.mockResolvedValueOnce(r);
  }
  return {
    query: queryMock,
    connect: vi.fn(),
  };
}

function makePoolWithClient(
  poolResponses: { rows: unknown[] }[],
  clientResponses: { rows: unknown[] }[],
) {
  const poolQuery = vi.fn();
  for (const r of poolResponses) {
    poolQuery.mockResolvedValueOnce(r);
  }

  const clientQuery = vi.fn();
  for (const r of clientResponses) {
    clientQuery.mockResolvedValueOnce(r);
  }

  const client = {
    query: clientQuery,
    release: vi.fn(),
  };

  return {
    query: poolQuery,
    connect: vi.fn(async () => client),
  };
}

describe("SqlGraphBackend.resolveEntities", () => {
  it("returns empty array for empty input", async () => {
    const pool = makePool([]);
    const backend = new SqlGraphBackend(pool as any);
    const result = await backend.resolveEntities([]);
    expect(result).toEqual([]);
  });

  it("resolves entities by exact case-insensitive match", async () => {
    const pool = makePool([
      {
        rows: [
          { id: "uuid-1", name: "AuthService", type: "service", description: null, mention_count: 3 },
        ],
      },
    ]);
    const backend = new SqlGraphBackend(pool as any);
    const result = await backend.resolveEntities(["authservice"]);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("AuthService");
    expect(result[0].id).toBe("uuid-1");
    expect(result[0].type).toBe("service");
  });

  it("deduplicates input names case-insensitively", async () => {
    const pool = makePool([
      {
        rows: [{ id: "uuid-1", name: "AuthService", type: "service", description: null, mention_count: 1 }],
      },
    ]);
    const backend = new SqlGraphBackend(pool as any);
    const result = await backend.resolveEntities(["AuthService", "authservice", "AUTHSERVICE"]);
    expect(result).toHaveLength(1);
    // Only one exact-match query should be issued
    expect((pool as any).query).toHaveBeenCalledTimes(1);
  });

  it("skips ambiguous exact case-insensitive matches when no exact-case row exists", async () => {
    const pool = makePool([
      {
        rows: [
          { id: "uuid-1", name: "AuthService", type: "service", description: null, mention_count: 1 },
          { id: "uuid-2", name: "AUTHSERVICE", type: "service", description: null, mention_count: 1 },
        ],
      },
      {
        rows: [
          { matched_prefix: "authservice", id: "uuid-1", name: "AuthService", type: "service", description: null, mention_count: 1 },
          { matched_prefix: "authservice", id: "uuid-2", name: "AUTHSERVICE", type: "service", description: null, mention_count: 1 },
        ],
      },
    ]);
    const backend = new SqlGraphBackend(pool as any);
    const result = await backend.resolveEntities(["authservice"]);
    expect(result).toHaveLength(0);
  });

  it("prefers exact-case row when multiple case-insensitive exact matches exist", async () => {
    const pool = makePool([
      {
        rows: [
          { id: "uuid-1", name: "AuthService", type: "service", description: null, mention_count: 1 },
          { id: "uuid-2", name: "AUTHSERVICE", type: "service", description: null, mention_count: 1 },
        ],
      },
    ]);
    const backend = new SqlGraphBackend(pool as any);
    const result = await backend.resolveEntities(["AUTHSERVICE"]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("uuid-2");
    expect(result[0].name).toBe("AUTHSERVICE");
    expect(result[0].requestedName).toBe("AUTHSERVICE");
  });

  it("returns empty for unresolved names when no prefix match", async () => {
    const pool = makePool([
      { rows: [] },  // exact match returns nothing
      { rows: [] },  // batched prefix fallback returns nothing
    ]);
    const backend = new SqlGraphBackend(pool as any);
    const result = await backend.resolveEntities(["unknown"]);
    expect(result).toEqual([]);
  });

  it("accepts prefix match when exactly one result", async () => {
    const pool = makePool([
      { rows: [] },  // exact match returns nothing
      {
        rows: [
          { matched_prefix: "auth", id: "uuid-2", name: "AuthService", type: "service", description: null, mention_count: 1 },
        ],
      },  // batched prefix returns 1 match for "auth"
    ]);
    const backend = new SqlGraphBackend(pool as any);
    const result = await backend.resolveEntities(["Auth"]);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("AuthService");
    // requestedName tracks the original input, not the resolved canonical name
    expect(result[0].requestedName).toBe("Auth");
  });

  it("rejects prefix match when multiple results (ambiguous)", async () => {
    const pool = makePool([
      { rows: [] },  // exact match returns nothing
      {
        rows: [
          { matched_prefix: "auth", id: "uuid-2", name: "AuthService", type: "service", description: null, mention_count: 1 },
          { matched_prefix: "auth", id: "uuid-3", name: "AuthProvider", type: "service", description: null, mention_count: 1 },
        ],
      },  // batched prefix returns 2 matches for "auth"
    ]);
    const backend = new SqlGraphBackend(pool as any);
    const result = await backend.resolveEntities(["Auth"]);
    expect(result).toHaveLength(0);
  });

  it("skips prefix fallback when more than 10 names are unresolved", async () => {
    const names = Array.from({ length: 11 }, (_, i) => `Entity${i}`);
    const pool = makePool([
      { rows: [] },  // exact match returns nothing for all 11
    ]);
    const backend = new SqlGraphBackend(pool as any);
    const result = await backend.resolveEntities(names);
    expect(result).toHaveLength(0);
    // Should NOT call prefix queries (only 1 call: the exact match)
    expect((pool as any).query).toHaveBeenCalledTimes(1);
  });
});

describe("SqlGraphBackend.getEntity", () => {
  it("returns null when entity not found", async () => {
    const pool = makePool([{ rows: [] }]);
    const backend = new SqlGraphBackend(pool as any);
    const result = await backend.getEntity("NonExistent");
    expect(result).toBeNull();
  });

  it("returns entity when found", async () => {
    const pool = makePool([
      {
        rows: [
          {
            id: "uuid-1",
            name: "AuthService",
            type: "service",
            description: "Authentication service",
            mention_count: 5,
          },
        ],
      },
    ]);
    const backend = new SqlGraphBackend(pool as any);
    const result = await backend.getEntity("authservice");
    expect(result).not.toBeNull();
    expect(result?.name).toBe("AuthService");
    expect(result?.mentionCount).toBe(5);
    expect(result?.description).toBe("Authentication service");
  });
});

describe("SqlGraphBackend.getEntityRelationships", () => {
  it("returns empty array when no relationships", async () => {
    const pool = makePool([{ rows: [] }]);
    const backend = new SqlGraphBackend(pool as any);
    const result = await backend.getEntityRelationships("uuid-1", 100);
    expect(result).toEqual([]);
  });

  it("returns bidirectional relationships", async () => {
    const pool = makePool([
      {
        rows: [
          { entity_name: "DatabaseService", relationship: "uses", direction: "outbound", description: null },
          { entity_name: "UserService", relationship: "depends_on", direction: "inbound", description: "dep desc" },
        ],
      },
    ]);
    const backend = new SqlGraphBackend(pool as any);
    const result = await backend.getEntityRelationships("uuid-1", 100);
    expect(result).toHaveLength(2);
    expect(result[0].direction).toBe("outbound");
    expect(result[0].entityName).toBe("DatabaseService");
    expect(result[1].direction).toBe("inbound");
    expect(result[1].description).toBe("dep desc");
  });
});

describe("SqlGraphBackend.getEntityDocuments", () => {
  it("returns empty array for empty entity IDs", async () => {
    const pool = makePool([]);
    const backend = new SqlGraphBackend(pool as any);
    const result = await backend.getEntityDocuments([], 10);
    expect(result).toEqual([]);
    expect((pool as any).query).not.toHaveBeenCalled();
  });

  it("returns document references", async () => {
    const pool = makePool([
      {
        rows: [
          {
            document_id: "doc-uuid-1",
            source: "https://example.com/doc",
            entity_name: "AuthService",
            mention_count: 3,
          },
        ],
      },
    ]);
    const backend = new SqlGraphBackend(pool as any);
    const result = await backend.getEntityDocuments(["entity-uuid-1"], 10);
    expect(result).toHaveLength(1);
    expect(result[0].documentId).toBe("doc-uuid-1");
    expect(result[0].entityName).toBe("AuthService");
    expect(result[0].mentionCount).toBe(3);
  });
});

describe("SqlGraphBackend.traverse", () => {
  it("returns empty result for empty seedIds", async () => {
    const pool = makePool([]);
    const backend = new SqlGraphBackend(pool as any);
    const result = await backend.traverse([], {
      maxDepth: 2,
      maxEntities: 50,
      relationshipTypes: [],
      includeDocuments: false,
      timeLimitMs: 5000,
    });
    expect(result.entities).toEqual([]);
    expect(result.relationships).toEqual([]);
    expect(result.meta.timedOut).toBe(false);
    expect((pool as any).connect).not.toHaveBeenCalled();
  });

  it("traverses and returns entities and relationships", async () => {
    const pool = makePoolWithClient(
      [],
      [
        { rows: [] },  // BEGIN
        { rows: [] },  // SET LOCAL statement_timeout
        {
          rows: [
            {
              id: "entity-a-uuid",
              name: "EntityA",
              type: "service",
              mention_count: 2,
              depth: 0,
              path_names: ["EntityA"],
              path_rel_types: [],
            },
            {
              id: "entity-b-uuid",
              name: "EntityB",
              type: "service",
              mention_count: 1,
              depth: 1,
              path_names: ["EntityA", "EntityB"],
              path_rel_types: ["calls"],
            },
          ],
        },
        {
          rows: [{ source_name: "EntityA", target_name: "EntityB", relationship_type: "calls" }],
        },
        { rows: [] },  // COMMIT
      ],
    );
    const backend = new SqlGraphBackend(pool as any);
    const result = await backend.traverse(["entity-a-uuid"], {
      maxDepth: 2,
      maxEntities: 50,
      relationshipTypes: [],
      includeDocuments: false,
      timeLimitMs: 5000,
    });

    expect(result.entities).toHaveLength(2);
    expect(result.entities[0].name).toBe("EntityA");
    expect(result.entities[0].isSeed).toBe(true);
    expect(result.entities[0].depth).toBe(0);
    expect(result.entities[1].name).toBe("EntityB");
    expect(result.entities[1].isSeed).toBe(false);
    expect(result.entities[1].depth).toBe(1);
    expect(result.relationships).toHaveLength(1);
    expect(result.relationships[0].source).toBe("EntityA");
    expect(result.relationships[0].target).toBe("EntityB");
    expect(result.relationships[0].type).toBe("calls");
    expect(result.meta.capped).toBe(false);
    expect(result.meta.timedOut).toBe(false);
  });

  it("sets capped=true when entity count equals maxEntities", async () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({
      id: `uuid-${i}`,
      name: `Entity${i}`,
      type: "service",
      mention_count: 0,
      depth: i,
      path_names: [`Entity${i}`],
      path_rel_types: [] as string[],
    }));

    const pool = makePoolWithClient(
      [],
      [
        { rows: [] },  // BEGIN
        { rows: [] },  // SET LOCAL
        { rows },      // traversal (returns maxEntities rows)
        { rows: [] },  // relationships
        { rows: [] },  // COMMIT
      ],
    );
    const backend = new SqlGraphBackend(pool as any);
    const result = await backend.traverse(["uuid-0"], {
      maxDepth: 2,
      maxEntities: 3,  // same as returned rows
      relationshipTypes: [],
      includeDocuments: false,
      timeLimitMs: 5000,
    });

    expect(result.meta.capped).toBe(true);
    expect(result.entities).toHaveLength(3);
  });

  it("returns timedOut=true on Postgres error 57014", async () => {
    const timeoutError = Object.assign(new Error("statement timeout"), { code: "57014" });

    const clientQuery = vi.fn()
      .mockResolvedValueOnce({ rows: [] })  // BEGIN
      .mockResolvedValueOnce({ rows: [] })  // SET LOCAL
      .mockRejectedValueOnce(timeoutError)  // traversal throws timeout
      .mockResolvedValueOnce({ rows: [] }); // ROLLBACK

    const client = { query: clientQuery, release: vi.fn() };
    const pool = {
      query: vi.fn(),
      connect: vi.fn(async () => client),
    };

    const backend = new SqlGraphBackend(pool as any);
    const result = await backend.traverse(["entity-uuid"], {
      maxDepth: 2,
      maxEntities: 50,
      relationshipTypes: [],
      includeDocuments: false,
      timeLimitMs: 5000,
    });

    expect(result.meta.timedOut).toBe(true);
    expect(result.meta.warnings).toContain("Graph traversal timed out; returning partial results");
  });

  it("constructs paths correctly using path_rel_types from CTE", async () => {
    const pool = makePoolWithClient(
      [],
      [
        { rows: [] },  // BEGIN
        { rows: [] },  // SET LOCAL
        {
          rows: [
            { id: "a", name: "A", type: "x", mention_count: 0, depth: 0, path_names: ["A"], path_rel_types: [] },
            { id: "b", name: "B", type: "x", mention_count: 0, depth: 1, path_names: ["A", "B"], path_rel_types: ["r1"] },
            { id: "c", name: "C", type: "x", mention_count: 0, depth: 2, path_names: ["A", "B", "C"], path_rel_types: ["r1", "r2"] },
          ],
        },
        {
          rows: [
            { source_name: "A", target_name: "B", relationship_type: "r1" },
            { source_name: "B", target_name: "C", relationship_type: "r2" },
          ],
        },
        { rows: [] },  // COMMIT
      ],
    );
    const backend = new SqlGraphBackend(pool as any);
    const result = await backend.traverse(["a"], {
      maxDepth: 3,
      maxEntities: 50,
      relationshipTypes: [],
      includeDocuments: false,
      timeLimitMs: 5000,
    });

    // Leaf path is A -> B -> C (B and A are prefixes, so not leaves)
    expect(result.paths).toHaveLength(1);
    expect(result.paths[0].entities).toEqual(["A", "B", "C"]);
    // Relationships come from path_rel_types tracked in the CTE, not from edge lookup
    expect(result.paths[0].relationships).toEqual(["r1", "r2"]);
    expect(result.paths[0].depth).toBe(2);
  });
});
