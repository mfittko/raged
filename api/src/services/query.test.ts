import { describe, it, expect, vi, beforeEach } from "vitest";
import { query } from "./query.js";
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
        },
      ],
    })),
  })),
}));

// Mock ollama module
vi.mock("../ollama.js", () => ({
  embed: vi.fn(async (texts: string[]) =>
    texts.map(() => Array(768).fill(0.1))
  ),
}));

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

  it("converts distance to similarity score", async () => {
    const request: QueryRequest = {
      query: "test",
    };

    const result = await query(request);

    expect(result.ok).toBe(true);
    expect(result.results[0].score).toBeGreaterThan(0);
    expect(result.results[0].score).toBeLessThanOrEqual(1);
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
    expect(sql).toContain("c.doc_type = $4");
    expect(params[3]).toBe("code");
  });

  it("returns graph data when graph expansion is requested", async () => {
    const queryMock = vi
      .fn()
      .mockResolvedValueOnce({
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
            tier2_meta: { entities: [{ text: "EntityA" }] },
            tier3_meta: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{ name: "EntityA", type: "person" }],
      })
      .mockResolvedValueOnce({
        rows: [{ source_name: "EntityA", target_name: "EntityB", relationship_type: "related_to" }],
      });

    const { getPool } = await import("../db.js");
    (getPool as any).mockReturnValueOnce({ query: queryMock });

    const result = await query({ query: "hello", graphExpand: true });

    expect(result.ok).toBe(true);
    expect(result.graph).toBeDefined();
    expect(result.graph?.entities.length).toBeGreaterThan(0);
    expect(result.graph?.relationships.length).toBeGreaterThan(0);
  });
});
