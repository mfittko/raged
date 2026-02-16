import { describe, it, expect, vi, beforeEach } from "vitest";
import { getEnrichmentStatus, getEnrichmentStats, enqueueEnrichment } from "./enrichment.js";

// Mock the db module
vi.mock("../db.js", () => ({
  getPool: vi.fn(() => ({
    query: vi.fn(async (sql: string) => {
      if (sql.includes("FROM chunks c")) {
        // getEnrichmentStatus query
        return {
          rows: [
            {
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
      } else if (sql.includes("FROM chunks")) {
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
      const poolQuery = vi
        .fn()
        .mockResolvedValueOnce({
          rows: [
            {
              chunk_id: "test-id:0",
              document_id: "doc-1",
              base_id: "test-id",
              chunk_index: 0,
              total_chunks: 1,
              text: "test",
              source: "test.txt",
              doc_type: "text",
              tier1_meta: {},
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [] });

      const { getPool } = await import("../db.js");
      (getPool as any).mockReturnValueOnce({
        query: poolQuery,
        connect: vi.fn(async () => ({
          query: vi.fn(async () => ({ rows: [] })),
          release: vi.fn(),
        })),
      });

      const result = await enqueueEnrichment({ collection: "test" });

      expect(result.ok).toBe(true);
      expect(result.enqueued).toBeGreaterThanOrEqual(0);
    });

    it("excludes already-enriched chunks when force is false", async () => {
      const poolQuery = vi
        .fn()
        .mockResolvedValueOnce({
          rows: [
            {
              chunk_id: "test-id:0",
              document_id: "doc-1",
              base_id: "test-id",
              chunk_index: 0,
              total_chunks: 1,
              text: "test",
              source: "test.txt",
              doc_type: "text",
              tier1_meta: {},
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [] });

      const clientQuery = vi.fn(async () => ({ rows: [] }));

      const { getPool } = await import("../db.js");
      (getPool as any).mockReturnValueOnce({
        query: poolQuery,
        connect: vi.fn(async () => ({
          query: clientQuery,
          release: vi.fn(),
        })),
      });

      const result = await enqueueEnrichment({ collection: "test", force: false });
      expect(result.ok).toBe(true);
      expect(result.enqueued).toBe(1);

      const [sql] = poolQuery.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain("c.enrichment_status != 'enriched'");
    });
  });
});
