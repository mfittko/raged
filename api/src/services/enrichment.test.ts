import { describe, it, expect, vi } from "vitest";
import {
  getEnrichmentStatus,
  getEnrichmentStats,
  enqueueEnrichment,
  type EnrichmentDeps,
} from "./enrichment.js";

describe("enrichment service", () => {
  describe("getEnrichmentStatus", () => {
    it("aggregates status from all chunks with same baseId", async () => {
      const deps: EnrichmentDeps = {
        collectionName: vi.fn(() => "docs"),
        getPointsByBaseId: vi.fn(async () => [
          {
            id: "repo:file.ts:0",
            payload: {
              enrichmentStatus: "enriched",
              enrichedAt: "2026-02-14T10:00:00Z",
              tier2: { entities: [], keywords: [] },
              tier3: { summary: "test" },
            },
          },
          {
            id: "repo:file.ts:1",
            payload: {
              enrichmentStatus: "enriched",
              enrichedAt: "2026-02-14T10:05:00Z",
              tier2: { entities: [], keywords: [] },
            },
          },
          {
            id: "repo:file.ts:2",
            payload: {
              enrichmentStatus: "enriched",
              enrichedAt: "2026-02-14T10:03:00Z",
            },
          },
        ]),
        scrollPointsPage: vi.fn(),
        scrollPoints: vi.fn(),
        getQueueLength: vi.fn(),
        enqueueTask: vi.fn(),
      };

      const result = await getEnrichmentStatus(
        { baseId: "repo:file.ts" },
        deps,
      );

      expect(result.status).toBe("enriched");
      expect(result.chunks.total).toBe(3);
      expect(result.chunks.enriched).toBe(3);
      expect(result.extractedAt).toBe("2026-02-14T10:05:00Z");
      // Verify metadata is returned from tier2/tier3
      expect(result.metadata).toBeDefined();
      expect(result.metadata?.tier2).toEqual({ entities: [], keywords: [] });
      expect(result.metadata?.tier3).toEqual({ summary: "test" });
    });

    it("returns mixed status when chunks are in different states", async () => {
      const deps: EnrichmentDeps = {
        collectionName: vi.fn(() => "docs"),
        getPointsByBaseId: vi.fn(async () => [
          { id: "repo:file.ts:0", payload: { enrichmentStatus: "enriched" } },
          { id: "repo:file.ts:1", payload: { enrichmentStatus: "pending" } },
          { id: "repo:file.ts:2", payload: { enrichmentStatus: "processing" } },
        ]),
        scrollPointsPage: vi.fn(),
        scrollPoints: vi.fn(),
        getQueueLength: vi.fn(),
        enqueueTask: vi.fn(),
      };

      const result = await getEnrichmentStatus(
        { baseId: "repo:file.ts" },
        deps,
      );

      expect(result.status).toBe("mixed");
      expect(result.chunks.enriched).toBe(1);
      expect(result.chunks.pending).toBe(1);
      expect(result.chunks.processing).toBe(1);
    });

    it("throws error when no chunks found", async () => {
      const deps: EnrichmentDeps = {
        collectionName: vi.fn(() => "docs"),
        getPointsByBaseId: vi.fn(async () => []),
        scrollPointsPage: vi.fn(),
        scrollPoints: vi.fn(),
        getQueueLength: vi.fn(),
        enqueueTask: vi.fn(),
      };

      await expect(
        getEnrichmentStatus({ baseId: "nonexistent" }, deps),
      ).rejects.toThrow("No chunks found");
    });
  });

  describe("getEnrichmentStats", () => {
    it("returns queue and status counts", async () => {
      const deps = {
        collectionName: vi.fn(() => "docs"),
        scrollPointsPage: vi
          .fn()
          .mockResolvedValueOnce({
            points: [
              { id: "1", payload: { enrichmentStatus: "enriched" } },
              { id: "2", payload: { enrichmentStatus: "enriched" } },
              { id: "3", payload: { enrichmentStatus: "pending" } },
              { id: "4", payload: { enrichmentStatus: "processing" } },
              { id: "5", payload: { enrichmentStatus: "failed" } },
              { id: "6", payload: { enrichmentStatus: "none" } },
            ],
            nextOffset: null,
          }),
        getQueueLength: vi.fn(async (queueName: string) => {
          if (queueName === "enrichment:pending") return 10;
          if (queueName === "enrichment:dead-letter") return 2;
          return 0;
        }),
      };

      const result = await getEnrichmentStats(deps);

      expect(result.queue.pending).toBe(10);
      expect(result.queue.deadLetter).toBe(2);
      expect(result.queue.processing).toBe(1);
      expect(result.totals.enriched).toBe(2);
      expect(result.totals.pending).toBe(1);
      expect(result.totals.processing).toBe(1);
      expect(result.totals.failed).toBe(1);
      expect(result.totals.none).toBe(1);
    });
  });

  describe("enqueueEnrichment", () => {
    it("enqueues points that are not enriched", async () => {
      const enqueueTask = vi.fn(async () => {});
      const deps: EnrichmentDeps = {
        collectionName: vi.fn(() => "docs"),
        getPointsByBaseId: vi.fn(),
        scrollPointsPage: vi
          .fn()
          .mockResolvedValueOnce({
            points: [
              {
                id: "repo:file1.ts:0",
                payload: {
                  enrichmentStatus: "pending",
                  docType: "code",
                  chunkIndex: 0,
                  text: "test text",
                  source: "file1.ts",
                  tier1Meta: {},
                },
              },
              {
                id: "repo:file2.ts:0",
                payload: {
                  enrichmentStatus: "failed",
                  docType: "code",
                  chunkIndex: 0,
                  text: "test text 2",
                  source: "file2.ts",
                  tier1Meta: {},
                },
              },
            ],
            nextOffset: null,
          })
          .mockResolvedValueOnce({
            points: [
              {
                id: "repo:file1.ts:0",
                payload: {
                  enrichmentStatus: "pending",
                  docType: "code",
                  chunkIndex: 0,
                  text: "test text",
                  source: "file1.ts",
                  tier1Meta: {},
                },
              },
              {
                id: "repo:file2.ts:0",
                payload: {
                  enrichmentStatus: "failed",
                  docType: "code",
                  chunkIndex: 0,
                  text: "test text 2",
                  source: "file2.ts",
                  tier1Meta: {},
                },
              },
            ],
            nextOffset: null,
          }),
        scrollPoints: vi.fn(async () => [
          {
            id: "repo:file1.ts:0",
            payload: {
              enrichmentStatus: "pending",
              docType: "code",
              chunkIndex: 0,
              text: "test text",
              source: "file1.ts",
              tier1Meta: {},
            },
          },
          {
            id: "repo:file2.ts:0",
            payload: {
              enrichmentStatus: "failed",
              docType: "code",
              chunkIndex: 0,
              text: "test text 2",
              source: "file2.ts",
              tier1Meta: {},
            },
          },
        ]),
        getQueueLength: vi.fn(),
        enqueueTask,
      };

      const result = await enqueueEnrichment({ collection: "docs" }, deps);

      expect(result.ok).toBe(true);
      expect(result.enqueued).toBe(2);
      expect(enqueueTask).toHaveBeenCalledTimes(2);
    });

    it("re-enqueues already enriched items when force=true", async () => {
      const enqueueTask = vi.fn(async () => {});
      const deps: EnrichmentDeps = {
        collectionName: vi.fn(() => "docs"),
        getPointsByBaseId: vi.fn(),
        scrollPointsPage: vi
          .fn()
          .mockResolvedValueOnce({
            points: [
              {
                id: "repo:file1.ts:0",
                payload: {
                  enrichmentStatus: "enriched",
                  docType: "code",
                  chunkIndex: 0,
                  text: "test text",
                  source: "file1.ts",
                  tier1Meta: {},
                },
              },
            ],
            nextOffset: null,
          })
          .mockResolvedValueOnce({
            points: [
              {
                id: "repo:file1.ts:0",
                payload: {
                  enrichmentStatus: "enriched",
                  docType: "code",
                  chunkIndex: 0,
                  text: "test text",
                  source: "file1.ts",
                  tier1Meta: {},
                },
              },
            ],
            nextOffset: null,
          }),
        scrollPoints: vi.fn(async () => [
          {
            id: "repo:file1.ts:0",
            payload: {
              enrichmentStatus: "enriched",
              docType: "code",
              chunkIndex: 0,
              text: "test text",
              source: "file1.ts",
              tier1Meta: {},
            },
          },
        ]),
        getQueueLength: vi.fn(),
        enqueueTask,
      };

      const result = await enqueueEnrichment(
        { collection: "docs", force: true },
        deps,
      );

      expect(result.ok).toBe(true);
      expect(result.enqueued).toBe(1);
      expect(enqueueTask).toHaveBeenCalledTimes(1);
    });
  });
});
