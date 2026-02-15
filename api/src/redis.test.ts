import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { enqueueEnrichment, getQueueLength, isEnrichmentEnabled } from "./redis.js";
import type { EnrichmentTask } from "./redis.js";

// Create mock client at module scope so we can access it in tests
const mockLPush = vi.fn(async () => 1);
const mockLLen = vi.fn(async () => 5);
const mockConnect = vi.fn(async () => {});
const mockQuit = vi.fn(async () => {});
const mockOn = vi.fn();

const mockClient = {
  lPush: mockLPush,
  lLen: mockLLen,
  connect: mockConnect,
  quit: mockQuit,
  on: mockOn,
};

// Mock the redis module
vi.mock("redis", () => ({
  createClient: vi.fn(() => mockClient),
}));

describe("redis module", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("isEnrichmentEnabled", () => {
    it("should return false when ENRICHMENT_ENABLED is not set", async () => {
      delete process.env.ENRICHMENT_ENABLED;
      delete process.env.REDIS_URL;
      
      const { isEnrichmentEnabled } = await import("./redis.js");
      expect(isEnrichmentEnabled()).toBe(false);
    });

    it("should return false when ENRICHMENT_ENABLED is true but REDIS_URL is not set", async () => {
      process.env.ENRICHMENT_ENABLED = "true";
      delete process.env.REDIS_URL;
      
      const { isEnrichmentEnabled } = await import("./redis.js");
      expect(isEnrichmentEnabled()).toBe(false);
    });

    it("should return true when both ENRICHMENT_ENABLED and REDIS_URL are set", async () => {
      process.env.ENRICHMENT_ENABLED = "true";
      process.env.REDIS_URL = "redis://localhost:6379";
      
      const { isEnrichmentEnabled } = await import("./redis.js");
      expect(isEnrichmentEnabled()).toBe(true);
    });
  });

  describe("enqueueEnrichment", () => {
    it("should silently skip when enrichment is disabled", async () => {
      delete process.env.ENRICHMENT_ENABLED;
      delete process.env.REDIS_URL;
      
      const { enqueueEnrichment } = await import("./redis.js");
      
      const task: EnrichmentTask = {
        taskId: "task-1",
        qdrantId: "point-1",
        collection: "docs",
        docType: "code",
        baseId: "base-1",
        chunkIndex: 0,
        totalChunks: 1,
        text: "test content",
        source: "test.ts",
        tier1Meta: {},
        attempt: 0,
        enqueuedAt: new Date().toISOString(),
      };
      
      await enqueueEnrichment(task);
      expect(mockLPush).not.toHaveBeenCalled();
    });

    it("should enqueue task when enrichment is enabled", async () => {
      process.env.ENRICHMENT_ENABLED = "true";
      process.env.REDIS_URL = "redis://localhost:6379";
      
      // Need to re-import after env change
      vi.resetModules();
      const { enqueueEnrichment } = await import("./redis.js");
      
      const task: EnrichmentTask = {
        taskId: "task-1",
        qdrantId: "point-1",
        collection: "docs",
        docType: "code",
        baseId: "base-1",
        chunkIndex: 0,
        totalChunks: 1,
        text: "test content",
        source: "test.ts",
        tier1Meta: { lang: "typescript" },
        attempt: 0,
        enqueuedAt: new Date().toISOString(),
      };
      
      await enqueueEnrichment(task);
      
      expect(mockLPush).toHaveBeenCalledWith(
        "enrichment:pending",
        JSON.stringify(task)
      );
    });
  });

  describe("getQueueLength", () => {
    it("should return 0 when enrichment is disabled", async () => {
      delete process.env.ENRICHMENT_ENABLED;
      delete process.env.REDIS_URL;
      
      const { getQueueLength } = await import("./redis.js");
      const length = await getQueueLength("enrichment:pending");
      expect(length).toBe(0);
    });

    it("should return queue length when enrichment is enabled", async () => {
      process.env.ENRICHMENT_ENABLED = "true";
      process.env.REDIS_URL = "redis://localhost:6379";
      
      vi.resetModules();
      const { getQueueLength } = await import("./redis.js");
      
      mockLLen.mockResolvedValueOnce(42);
      
      const length = await getQueueLength("enrichment:pending");
      expect(length).toBe(42);
      expect(mockLLen).toHaveBeenCalledWith("enrichment:pending");
    });
  });
});
