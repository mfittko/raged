import { describe, it, expect, vi, beforeEach } from "vitest";
import { query, countQueryTerms, getAutoMinScore } from "./query.js";
import type { QueryRequest } from "./query.js";

// Mock the db module
vi.mock("../db.js", () => ({
  getPool: vi.fn(() => ({
    query: vi.fn(async () => ({
      rows: [
        {
          chunk_id: "test-id:0",
          distance: 0.1,
          text: "hello world",
          source: "test.txt",
          chunk_index: 0,
          base_id: "test-id",
          doc_type: "text",
          repo_id: null,
          repo_url: null,
          path: null,
          lang: null,
          item_url: null,
          tier1_meta: {},
          tier2_meta: null,
          tier3_meta: null,
          doc_summary: null,
          doc_summary_short: null,
          doc_summary_medium: null,
          doc_summary_long: null,
          payload_checksum: null,
        },
      ],
    })),
  })),
}));

// Mock embeddings module
vi.mock("../embeddings.js", () => ({
  embed: vi.fn(async (texts: string[]) =>
    texts.map(() => Array(768).fill(0.1))
  ),
}));

describe("countQueryTerms", () => {
  it("counts single term", () => {
    expect(countQueryTerms("hello")).toBe(1);
  });

  it("counts multiple terms", () => {
    expect(countQueryTerms("hello world foo")).toBe(3);
  });

  it("ignores extra whitespace", () => {
    expect(countQueryTerms("  hello   world  ")).toBe(2);
  });

  it("returns 0 for empty string", () => {
    expect(countQueryTerms("")).toBe(0);
  });
});

describe("getAutoMinScore", () => {
  it("returns 0.3 for 1 term", () => {
    expect(getAutoMinScore("hello")).toBe(0.3);
  });

  it("returns 0.4 for 2 terms", () => {
    expect(getAutoMinScore("hello world")).toBe(0.4);
  });

  it("returns 0.5 for 3 terms", () => {
    expect(getAutoMinScore("hello world foo")).toBe(0.5);
  });

  it("returns 0.5 for 4 terms", () => {
    expect(getAutoMinScore("hello world foo bar")).toBe(0.5);
  });

  it("returns 0.6 for 5+ terms", () => {
    expect(getAutoMinScore("hello world foo bar baz")).toBe(0.6);
    expect(getAutoMinScore("a b c d e f")).toBe(0.6);
  });
});

describe("query service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("performs vector search and returns results", async () => {
    const request: QueryRequest = {
      query: "hello",
    };

    const result = await query(request);

    expect(result.ok).toBe(true);
    expect(result.results).toBeDefined();
    expect(result.results.length).toBeGreaterThan(0);
  });

  it("uses custom topK when specified", async () => {
    const request: QueryRequest = {
      query: "hello",
      topK: 5,
    };

    const result = await query(request);

    expect(result.ok).toBe(true);
  });

  it("uses default topK of 8 when not specified", async () => {
    const request: QueryRequest = {
      query: "hello",
    };

    const result = await query(request);

    expect(result.ok).toBe(true);
  });

  it("uses custom minScore when specified", async () => {
    const queryMock = vi.fn(async () => ({ rows: [] }));
    const { getPool } = await import("../db.js");
    (getPool as any).mockReturnValueOnce({ query: queryMock });

    await query({ query: "hello world", minScore: 0.7 });

    const firstCall = queryMock.mock.calls[0] as unknown as unknown[];
    const params = (firstCall[1] ?? []) as unknown[];
    // maxDistance = 1 - 0.7 = 0.3, stored as $4
    expect(params[3]).toBeCloseTo(0.3);
  });

  it("uses auto minScore when not specified", async () => {
    const queryMock = vi.fn(async () => ({ rows: [] }));
    const { getPool } = await import("../db.js");
    (getPool as any).mockReturnValueOnce({ query: queryMock });

    // 2 terms → minScore 0.4 → maxDistance 0.6
    await query({ query: "hello world" });

    const firstCall = queryMock.mock.calls[0] as unknown as unknown[];
    const params = (firstCall[1] ?? []) as unknown[];
    expect(params[3]).toBeCloseTo(0.6);
  });

  it("converts distance to similarity score", async () => {
    const request: QueryRequest = {
      query: "test",
    };

    const result = await query(request);

    expect(result.ok).toBe(true);
    expect(result.results[0].score).toBeGreaterThan(0);
    expect(result.results[0].score).toBeLessThanOrEqual(1);
  });

  it("includes summary and checksum fields in payload", async () => {
    const queryMock = vi.fn(async () => ({
      rows: [
        {
          chunk_id: "test-id:0",
          distance: 0.1,
          text: "hello world",
          source: "test.txt",
          chunk_index: 0,
          base_id: "test-id",
          doc_type: "text",
          repo_id: null,
          repo_url: null,
          path: null,
          lang: null,
          item_url: null,
          tier1_meta: {},
          tier2_meta: null,
          tier3_meta: null,
          doc_summary: "A short summary",
          doc_summary_short: "Short",
          doc_summary_medium: "Medium summary",
          doc_summary_long: "A longer summary",
          payload_checksum: "abc123",
        },
      ],
    }));

    const { getPool } = await import("../db.js");
    (getPool as any).mockReturnValueOnce({ query: queryMock });

    const result = await query({ query: "hello" });

    expect(result.ok).toBe(true);
    expect(result.results[0].payload?.docSummary).toBe("A short summary");
    expect(result.results[0].payload?.docSummaryShort).toBe("Short");
    expect(result.results[0].payload?.docSummaryMedium).toBe("Medium summary");
    expect(result.results[0].payload?.docSummaryLong).toBe("A longer summary");
    expect(result.results[0].payload?.payloadChecksum).toBe("abc123");
  });

  it("handles empty results gracefully", async () => {
    const { getPool } = await import("../db.js");
    (getPool as any).mockReturnValueOnce({
      query: vi.fn(async () => ({ rows: [] })),
    });

    const request: QueryRequest = {
      query: "nothing matches this",
    };

    const result = await query(request);

    expect(result.ok).toBe(true);
    expect(result.results.length).toBe(0);
  });

  it("applies translated filters with chunk table alias", async () => {
    const queryMock = vi.fn(async () => ({
      rows: [
        {
          chunk_id: "test-id:0",
          distance: 0.1,
          text: "hello world",
          source: "test.txt",
          chunk_index: 0,
          base_id: "test-id",
          doc_type: "code",
          repo_id: null,
          repo_url: null,
          path: null,
          lang: null,
          item_url: null,
          tier1_meta: {},
          tier2_meta: null,
          tier3_meta: null,
          doc_summary: null,
          doc_summary_short: null,
          doc_summary_medium: null,
          doc_summary_long: null,
          payload_checksum: null,
        },
      ],
    }));

    const { getPool } = await import("../db.js");
    (getPool as any).mockReturnValueOnce({ query: queryMock });

    await query({ query: "hello", filter: { docType: "code" } });

    expect(queryMock).toHaveBeenCalled();
    const firstCall = queryMock.mock.calls[0];
    expect(firstCall).toBeDefined();
    const firstCallArgs = firstCall as unknown as unknown[];
    const sql = String(firstCallArgs[0] ?? "");
    const params = (firstCallArgs[1] ?? []) as unknown[];
    expect(sql).toContain("c.doc_type = $5");
    expect(params[4]).toBe("code");
  });

  it("returns graph data when graph expansion is requested", async () => {
    const chunkRow = {
      chunk_id: "test-id:0",
      distance: 0.1,
      text: "hello world",
      source: "test.txt",
      chunk_index: 0,
      base_id: "test-id",
      doc_type: "text",
      repo_id: null,
      repo_url: null,
      path: null,
      lang: null,
      item_url: null,
      tier1_meta: {},
      tier2_meta: { entities: [{ text: "EntityA" }] },
      tier3_meta: null,
      doc_summary: null,
      doc_summary_short: null,
      doc_summary_medium: null,
      doc_summary_long: null,
      payload_checksum: null,
    };

    const resolvedEntityRow = {
      id: "entity-a-uuid",
      name: "EntityA",
      type: "person",
      description: null,
      mention_count: 0,
    };

    const traversalEntityRow = {
      id: "entity-a-uuid",
      name: "EntityA",
      type: "person",
      mention_count: 0,
      depth: 0,
      path_names: ["EntityA"],
    };

    const relationshipRow = {
      source_name: "EntityA",
      target_name: "EntityB",
      relationship_type: "related_to",
    };

    const clientQueryMock = vi.fn()
      .mockResolvedValueOnce({ rows: [] })                              // BEGIN
      .mockResolvedValueOnce({ rows: [] })                              // SET LOCAL statement_timeout
      .mockResolvedValueOnce({ rows: [traversalEntityRow] })            // traversal CTE
      .mockResolvedValueOnce({ rows: [relationshipRow] })               // relationships
      .mockResolvedValueOnce({ rows: [] });                             // COMMIT

    const poolQueryMock = vi.fn()
      .mockResolvedValueOnce({ rows: [chunkRow] })                      // vector search
      .mockResolvedValueOnce({ rows: [resolvedEntityRow] });            // resolveEntities

    const { getPool } = await import("../db.js");
    (getPool as any).mockReturnValueOnce({
      query: poolQueryMock,
      connect: vi.fn(async () => ({
        query: clientQueryMock,
        release: vi.fn(),
      })),
    });

    const result = await query({ query: "hello", graphExpand: true });

    expect(result.ok).toBe(true);
    expect(result.graph).toBeDefined();
    expect(result.graph?.entities.length).toBeGreaterThan(0);
    expect(result.graph?.relationships.length).toBeGreaterThan(0);
  });
});
