import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

// Mock query-router to always return semantic so existing tests exercise the
// vector-search path without being affected by routing classification logic.
// Routing behavior is tested separately in query-router.test.ts.
vi.mock("./query-router.js", () => ({
  classifyQuery: vi.fn(async () => ({
    strategy: "semantic",
    method: "default",
    confidence: 1.0,
    durationMs: 0,
  })),
}));

// Mock query-filter-parser so existing tests are not affected by filter
// extraction. Integration tests set ROUTER_FILTER_LLM_ENABLED=true in beforeEach
// to enable extractor invocation.
vi.mock("./query-filter-parser.js", () => ({
  extractStructuredFilter: vi.fn(async () => null),
  isFilterLlmEnabled: vi.fn(() => process.env.ROUTER_FILTER_LLM_ENABLED === "true"),
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
      path_rel_types: [],
    };

    const traversalEntityRowB = {
      id: "entity-b-uuid",
      name: "EntityB",
      type: "person",
      mention_count: 0,
      depth: 1,
      path_names: ["EntityA", "EntityB"],
      path_rel_types: ["related_to"],
    };

    const relationshipRow = {
      source_name: "EntityA",
      target_name: "EntityB",
      relationship_type: "related_to",
    };

    const clientQueryMock = vi.fn()
      .mockResolvedValueOnce({ rows: [] })                              // BEGIN
      .mockResolvedValueOnce({ rows: [] })                              // SET LOCAL statement_timeout
      .mockResolvedValueOnce({ rows: [traversalEntityRow, traversalEntityRowB] }) // traversal CTE
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
    expect(result.graph?.entities).toEqual([
      {
        name: "EntityA",
        type: "person",
        depth: 0,
        isSeed: true,
        mentionCount: 0,
      },
      {
        name: "EntityB",
        type: "person",
        depth: 1,
        isSeed: false,
        mentionCount: 0,
      },
    ]);
    expect(result.graph?.relationships).toEqual([
      {
        source: "EntityA",
        target: "EntityB",
        type: "related_to",
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// LLM filter extraction integration
// ---------------------------------------------------------------------------

describe("query service — LLM filter extraction integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ROUTER_FILTER_LLM_ENABLED = "true";
  });

  afterEach(() => {
    delete process.env.ROUTER_FILTER_LLM_ENABLED;
  });

  it("does NOT call filter extractor when explicit filter is provided", async () => {
    const { extractStructuredFilter } = await import("./query-filter-parser.js");

    const result = await query({
      query: "typescript files",
      filter: { docType: "code" },
    });

    expect(extractStructuredFilter).not.toHaveBeenCalled();
    expect(result.routing.inferredFilter).toBeUndefined();
  });

  it("calls filter extractor when no filter and routing is ambiguous (default)", async () => {
    const { extractStructuredFilter } = await import("./query-filter-parser.js");
    (extractStructuredFilter as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    await query({ query: "all invoices from 2023" });

    expect(extractStructuredFilter).toHaveBeenCalledWith(
      expect.objectContaining({ query: "all invoices from 2023" }),
    );
  });

  it("sets routing.inferredFilter=true and applies inferred filter to SQL query", async () => {
    const { extractStructuredFilter } = await import("./query-filter-parser.js");
    (extractStructuredFilter as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      conditions: [{ field: "lang", op: "eq", value: "ts" }],
      combine: "and",
    });

    const queryMock = vi.fn(async () => ({ rows: [] }));
    const { getPool } = await import("../db.js");
    (getPool as any).mockReturnValueOnce({ query: queryMock });

    const result = await query({ query: "all typescript files from 2023" });

    expect(result.routing.inferredFilter).toBe(true);
    const firstCall = queryMock.mock.calls[0] as unknown as unknown[];
    const sql = String(firstCall[0] ?? "");
    // inferred lang filter should appear in the SQL
    expect(sql).toContain("c.lang = $5");
  });

  it("does NOT set inferredFilter when extractor returns null", async () => {
    const { extractStructuredFilter } = await import("./query-filter-parser.js");
    (extractStructuredFilter as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    const result = await query({ query: "how does authentication work" });

    expect(result.routing.inferredFilter).toBeUndefined();
  });

  it("preserves existing behavior when extractor returns null (no filter applied)", async () => {
    const { extractStructuredFilter } = await import("./query-filter-parser.js");
    (extractStructuredFilter as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    const queryMock = vi.fn(async () => ({ rows: [] }));
    const { getPool } = await import("../db.js");
    (getPool as any).mockReturnValueOnce({ query: queryMock });

    const result = await query({ query: "general semantic search" });

    expect(result.ok).toBe(true);
    expect(result.routing.inferredFilter).toBeUndefined();
    const firstCall = queryMock.mock.calls[0] as unknown as unknown[];
    const sql = String(firstCall[0] ?? "");
    // No extra filter conditions in the WHERE clause
    expect(sql).not.toContain("$5");
  });

  // Explicit coverage for issue #130 required example queries
  it("applies inferred temporal range filter for 'all openai invoices from 2023 and 2024'", async () => {
    const { extractStructuredFilter } = await import("./query-filter-parser.js");
    (extractStructuredFilter as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      conditions: [
        {
          field: "ingestedAt",
          op: "between",
          range: { low: "2023-01-01", high: "2024-12-31" },
        },
      ],
      combine: "and",
    });

    const queryMock = vi.fn(async () => ({ rows: [] }));
    const { getPool } = await import("../db.js");
    (getPool as any).mockReturnValueOnce({ query: queryMock });

    const result = await query({ query: "all openai invoices from 2023 and 2024" });

    expect(result.routing.inferredFilter).toBe(true);
    const firstCall = queryMock.mock.calls[0] as unknown as unknown[];
    const sql = String(firstCall[0] ?? "");
    // between on ingestedAt expands to >= low AND <= high
    expect(sql).toContain("d.ingested_at >= $5 AND d.ingested_at <= $6");
  });

  it("applies multi-constraint inferred filter for 'python files ingested in 2024'", async () => {
    const { extractStructuredFilter } = await import("./query-filter-parser.js");
    (extractStructuredFilter as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      conditions: [
        { field: "lang", op: "eq", value: "py" },
        { field: "ingestedAt", op: "gte", value: "2024-01-01" },
      ],
      combine: "and",
    });

    const queryMock = vi.fn(async () => ({ rows: [] }));
    const { getPool } = await import("../db.js");
    (getPool as any).mockReturnValueOnce({ query: queryMock });

    const result = await query({ query: "python files ingested in 2024" });

    expect(result.routing.inferredFilter).toBe(true);
    const firstCall = queryMock.mock.calls[0] as unknown as unknown[];
    const sql = String(firstCall[0] ?? "");
    expect(sql).toContain("c.lang = $5");
    expect(sql).toContain("d.ingested_at >= $6");
  });
});

describe("query service — hybrid dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("dispatches to hybridMetadataFlow when strategy=hybrid with filter, no graphExpand", async () => {
    const { classifyQuery } = await import("./query-router.js");
    (classifyQuery as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      strategy: "hybrid",
      method: "rule",
      confidence: 0.8,
      durationMs: 1,
    });

    // Phase 1 returns no candidates → hybridMetadataFlow returns []
    const { getPool } = await import("../db.js");
    (getPool as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      query: vi.fn(async () => ({ rows: [] })),
    });

    const result = await query({ query: "find docs", filter: { docType: "code" } });

    expect(result.ok).toBe(true);
    expect(result.routing.strategy).toBe("hybrid");
    // embed() must NOT be called when metadata phase returns no candidates
    const { embed } = await import("../embeddings.js");
    expect(embed).not.toHaveBeenCalled();
  });

  it("dispatches to hybridGraphFlow when strategy=hybrid with graphExpand=true", async () => {
    const { classifyQuery } = await import("./query-router.js");
    (classifyQuery as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      strategy: "hybrid",
      method: "rule",
      confidence: 0.8,
      durationMs: 1,
    });

    // Seed search returns no rows → hybridGraphFlow falls back to []
    const { getPool } = await import("../db.js");
    (getPool as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      query: vi.fn(async () => ({ rows: [] })),
    });

    const result = await query({ query: "related entities", graphExpand: true });

    expect(result.ok).toBe(true);
    expect(result.routing.strategy).toBe("hybrid");
    // embed() IS called for Flow 2 (needed for seed search)
    const { embed } = await import("../embeddings.js");
    expect(embed).toHaveBeenCalledTimes(1);
  });

  it("dispatches to hybridGraphFlow when strategy=hybrid with no filter (relational_pattern)", async () => {
    const { classifyQuery } = await import("./query-router.js");
    (classifyQuery as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      strategy: "hybrid",
      method: "rule",
      rule: "relational_pattern",
      confidence: 0.6,
      durationMs: 1,
    });

    const { getPool } = await import("../db.js");
    (getPool as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      query: vi.fn(async () => ({ rows: [] })),
    });

    // No filter, no graphExpand → should go to Flow 2 (graph), not Flow 1 (metadata)
    const result = await query({ query: "how does X relate to Y" });

    expect(result.ok).toBe(true);
    expect(result.routing.strategy).toBe("hybrid");
    // embed() IS called — confirms Flow 2 path was taken
    const { embed } = await import("../embeddings.js");
    expect(embed).toHaveBeenCalledTimes(1);
  });
});
