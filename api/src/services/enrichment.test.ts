import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getEnrichmentStatus,
  getEnrichmentStats,
  enqueueEnrichment,
  clearEnrichmentQueue,
} from "./enrichment.js";

// Mock the db module
vi.mock("../db.js", () => ({
  getPool: vi.fn(() => ({
    query: vi.fn(async (sql: string) => {
      if (sql.includes("FROM chunks c") && sql.includes("WHERE d.base_id")) {
        // getEnrichmentStatus query
        return {
          rows: [
            {
              chunk_index: 0,
              enrichment_status: "enriched",
              enriched_at: new Date().toISOString(),
              tier2_meta: { entities: [] },
              tier3_meta: null,
            },
          ],
        };
      } else if (sql.includes("FROM task_queue")) {
        // getEnrichmentStats query
        return {
          rows: [
            { status: "pending", count: 10 },
            { status: "processing", count: 2 },
          ],
        };
      } else if (sql.includes("FROM chunks c") && sql.includes("GROUP BY COALESCE")) {
        // getEnrichmentStats chunks query
        return {
          rows: [
            { enrichment_status: "enriched", count: 50 },
            { enrichment_status: "pending", count: 10 },
          ],
        };
      } else if (sql.includes("SELECT") && sql.includes("chunk_id")) {
        // enqueueEnrichment query
        return {
          rows: [
            {
              chunk_id: "test-id:0",
              base_id: "test-id",
              chunk_index: 0,
              text: "test",
              source: "test.txt",
              doc_type: "text",
              tier1_meta: {},
            },
          ],
        };
      }
      return { rows: [] };
    }),
    connect: vi.fn(async () => ({
      query: vi.fn(async () => ({ rows: [] })),
      release: vi.fn(),
    })),
  })),
}));

describe("enrichment service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getEnrichmentStatus", () => {
    it("returns status for a document", async () => {
      const result = await getEnrichmentStatus({ baseId: "test-id" });

      expect(result.baseId).toBe("test-id");
      expect(result.status).toBeDefined();
      expect(result.chunks).toBeDefined();
    });

    it("throws 404 when document not found", async () => {
      const { getPool } = await import("../db.js");
      (getPool as any).mockReturnValueOnce({
        query: vi.fn(async () => ({ rows: [] })),
      });

      await expect(
        getEnrichmentStatus({ baseId: "nonexistent" })
      ).rejects.toThrow();
    });

    it("returns mixed status when chunks have different states", async () => {
      const { getPool } = await import("../db.js");
      (getPool as any).mockReturnValueOnce({
        query: vi.fn(async () => ({
          rows: [
            {
              enrichment_status: "enriched",
              enriched_at: new Date().toISOString(),
              tier2_meta: null,
              tier3_meta: null,
            },
            {
              enrichment_status: "pending",
              enriched_at: null,
              tier2_meta: null,
              tier3_meta: null,
            },
          ],
        })),
      });

      const result = await getEnrichmentStatus({ baseId: "mixed-id" });
      expect(result.status).toBe("mixed");
      expect(result.chunks.total).toBe(2);
    });

    it("includes chunk error metadata when available", async () => {
      const { getPool } = await import("../db.js");
      (getPool as any).mockReturnValueOnce({
        query: vi.fn(async () => ({
          rows: [
            {
              chunk_index: 3,
              enrichment_status: "failed",
              enriched_at: null,
              tier2_meta: null,
              tier3_meta: {
                _error: {
                  message: "controlled-failure",
                  taskId: "task-abc",
                  attempt: 2,
                  maxAttempts: 3,
                  final: false,
                  failedAt: "2026-02-17T00:00:00Z",
                },
              },
            },
          ],
        })),
      });

      const result = await getEnrichmentStatus({ baseId: "failed-id" });
      expect(result.status).toBe("failed");
      expect(result.metadata?.error).toEqual({
        message: "controlled-failure",
        taskId: "task-abc",
        attempt: 2,
        maxAttempts: 3,
        final: false,
        failedAt: "2026-02-17T00:00:00Z",
        chunkIndex: 3,
      });
    });
  });

  describe("getEnrichmentStats", () => {
    it("returns queue and chunk statistics", async () => {
      const result = await getEnrichmentStats();

      expect(result.queue).toBeDefined();
      expect(result.totals).toBeDefined();
    });
  });

  describe("enqueueEnrichment", () => {
    it("enqueues chunks for enrichment", async () => {
      const clientQuery = vi
        .fn()
        .mockResolvedValueOnce({
          rows: [
            {
              chunk_id: "test-id:0",
              document_id: "doc-1",
              base_id: "test-id",
              chunk_index: 0,
              text: "test",
              source: "test.txt",
              doc_type: "text",
              tier1_meta: {},
            },
          ],
        })
        .mockResolvedValueOnce({
          rows: [{ document_id: "doc-1", total_chunks: 1 }],
        })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });

      const { getPool } = await import("../db.js");
      (getPool as any).mockReturnValueOnce({
        query: vi.fn(async () => ({ rows: [] })),
        connect: vi.fn(async () => ({
          query: clientQuery,
          release: vi.fn(),
        })),
      });

      const result = await enqueueEnrichment({ collection: "test" });

      expect(result.ok).toBe(true);
      expect(result.enqueued).toBeGreaterThanOrEqual(0);
    });

    it("excludes already-enriched chunks when force is false", async () => {
      const clientQuery = vi
        .fn()
        .mockResolvedValueOnce({
          rows: [
            {
              chunk_id: "test-id:0",
              document_id: "doc-1",
              base_id: "test-id",
              chunk_index: 0,
              text: "test",
              source: "test.txt",
              doc_type: "text",
              tier1_meta: {},
            },
          ],
        })
        .mockResolvedValueOnce({
          rows: [{ document_id: "doc-1", total_chunks: 1 }],
        })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });

      const { getPool } = await import("../db.js");
      (getPool as any).mockReturnValueOnce({
        query: vi.fn(async () => ({ rows: [] })),
        connect: vi.fn(async () => ({
          query: clientQuery,
          release: vi.fn(),
        })),
      });

      const result = await enqueueEnrichment({ collection: "test", force: false });
      expect(result.ok).toBe(true);
      expect(result.enqueued).toBe(1);

      const [sql] = clientQuery.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain("c.enrichment_status != 'enriched'");
    });

    it("applies full-text filter when provided", async () => {
      const clientQuery = vi
        .fn()
        .mockResolvedValueOnce({ rows: [] });

      const { getPool } = await import("../db.js");
      (getPool as any).mockReturnValueOnce({
        query: vi.fn(async () => ({ rows: [] })),
        connect: vi.fn(async () => ({
          query: clientQuery,
          release: vi.fn(),
        })),
      });

      const result = await enqueueEnrichment({ collection: "test", filter: "invoice" }, "test");

      expect(result.ok).toBe(true);
      expect(result.enqueued).toBe(0);

      const [sql, params] = clientQuery.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain("websearch_to_tsquery");
      expect(sql).toContain("ILIKE");
      expect(params).toEqual(["test", "invoice", "%invoice%", 1000]);
    });
  });

  describe("clearEnrichmentQueue", () => {
    it("clears queued tasks for a collection", async () => {
      const poolQuery = vi.fn().mockResolvedValueOnce({ rowCount: 3, rows: [{ id: "1" }] });

      const { getPool } = await import("../db.js");
      (getPool as any).mockReturnValueOnce({
        query: poolQuery,
      });

      const result = await clearEnrichmentQueue({ collection: "test" }, "test");

      expect(result.ok).toBe(true);
      expect(result.cleared).toBe(3);

      const [sql, params] = poolQuery.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain("DELETE FROM task_queue");
      expect(sql).toContain("status IN ('pending', 'processing', 'dead')");
      expect(params).toEqual(["test"]);
    });

    it("applies full-text filter when clearing", async () => {
      const poolQuery = vi.fn().mockResolvedValueOnce({ rowCount: 2, rows: [{ id: "1" }, { id: "2" }] });

      const { getPool } = await import("../db.js");
      (getPool as any).mockReturnValueOnce({
        query: poolQuery,
      });

      const result = await clearEnrichmentQueue({ collection: "test", filter: "invoice" }, "test");

      expect(result.ok).toBe(true);
      expect(result.cleared).toBe(2);

      const [sql, params] = poolQuery.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain("websearch_to_tsquery");
      expect(sql).toContain("ILIKE");
      expect(params).toEqual(["test", "invoice", "%invoice%"]);
    });
  });
});
