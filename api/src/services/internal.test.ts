import { describe, it, expect, vi, beforeEach } from "vitest";
import { claimTask, submitTaskResult, failTask, recoverStaleTasks } from "./internal.js";

// Mock the db module
vi.mock("../db.js", () => ({
  getPool: vi.fn(() => ({
    connect: vi.fn(async () => ({
      query: vi.fn(async (sql: string) => {
        if (sql.includes("UPDATE task_queue")) {
          return {
            rows: [
              {
                id: "task-123",
                payload: {
                  chunkId: "base-id:0",
                  collection: "docs",
                  baseId: "base-id",
                },
                attempt: 1,
              },
            ],
          };
        }
        if (sql.includes("FROM chunks c")) {
          return {
            rows: [
              { chunk_index: 0, text: "chunk 0 text" },
              { chunk_index: 1, text: "chunk 1 text" },
            ],
          };
        }
        if (sql.includes("FROM documents WHERE base_id")) {
          return { rows: [{ id: "doc-123" }] };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    })),
    query: vi.fn(async () => ({ rows: [] })),
  })),
}));

describe("internal service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("claimTask", () => {
    it("claims a task and returns payload with chunk texts", async () => {
      const result = await claimTask({ workerId: "worker-1", leaseDuration: 300 });

      expect(result.task).toBeDefined();
      expect(result.task?.id).toBe("task-123");
      expect(result.chunks).toBeDefined();
      expect(result.chunks?.length).toBe(2);
    });

    it("returns empty object when no tasks available", async () => {
      const { getPool } = await import("../db.js");
      (getPool as any).mockReturnValueOnce({
        connect: vi.fn(async () => ({
          query: vi.fn(async () => ({ rows: [] })),
          release: vi.fn(),
        })),
      });

      const result = await claimTask({ workerId: "worker-1" });
      expect(result.task).toBeUndefined();
      expect(result.chunks).toBeUndefined();
    });

    it("uses default worker ID and lease duration when not provided", async () => {
      const result = await claimTask({});
      // Should not throw and should work with defaults
      expect(result).toBeDefined();
    });
  });

  describe("submitTaskResult", () => {
    it("submits enrichment results successfully", async () => {
      await expect(
        submitTaskResult("task-123", {
          chunkId: "base-id:0",
          collection: "docs",
          tier2: { entities: [] },
          tier3: {},
          entities: [
            { name: "Entity1", type: "person" },
          ],
          relationships: [],
        })
      ).resolves.not.toThrow();
    });

    it("validates chunkId format", async () => {
      await expect(
        submitTaskResult("task-123", {
          chunkId: "invalid-format",
          collection: "docs",
        })
      ).rejects.toThrow("Invalid chunkId format");
    });

    it("validates chunk index is a number", async () => {
      await expect(
        submitTaskResult("task-123", {
          chunkId: "base-id:abc",
          collection: "docs",
        })
      ).rejects.toThrow("Invalid chunk index");
    });

    it("validates chunk index is non-negative", async () => {
      await expect(
        submitTaskResult("task-123", {
          chunkId: "base-id:-1",
          collection: "docs",
        })
      ).rejects.toThrow("Invalid chunk index");
    });

    it("accepts chunkId when baseId contains colons", async () => {
      await expect(
        submitTaskResult("task-123", {
          chunkId: "repo:file.py:0",
          collection: "docs",
        })
      ).resolves.not.toThrow();
    });
  });

  describe("failTask", () => {
    it("marks task as failed", async () => {
      const { getPool } = await import("../db.js");
      (getPool as any).mockReturnValueOnce({
        connect: vi.fn(async () => ({
          query: vi.fn(async (sql: string) => {
            if (sql.includes("SELECT attempt")) {
              return { rows: [{ attempt: 1, max_attempts: 3 }] };
            }
            return { rows: [] };
          }),
          release: vi.fn(),
        })),
      });

      await expect(
        failTask("task-123", { error: "Test error" })
      ).resolves.not.toThrow();
    });

    it("moves to dead letter after max attempts", async () => {
      const { getPool } = await import("../db.js");
      (getPool as any).mockReturnValueOnce({
        connect: vi.fn(async () => ({
          query: vi.fn(async (sql: string) => {
            if (sql.includes("SELECT attempt")) {
              return { rows: [{ attempt: 3, max_attempts: 3 }] };
            }
            return { rows: [] };
          }),
          release: vi.fn(),
        })),
      });

      await expect(
        failTask("task-123", { error: "Final attempt failed" })
      ).resolves.not.toThrow();
    });
  });

  describe("recoverStaleTasks", () => {
    it("recovers stale tasks", async () => {
      const { getPool } = await import("../db.js");
      (getPool as any).mockReturnValueOnce({
        query: vi.fn(async () => ({ rowCount: 5 })),
      });

      const result = await recoverStaleTasks();
      expect(result.recovered).toBe(5);
    });

    it("returns 0 when no stale tasks", async () => {
      const { getPool } = await import("../db.js");
      (getPool as any).mockReturnValueOnce({
        query: vi.fn(async () => ({ rowCount: 0 })),
      });

      const result = await recoverStaleTasks();
      expect(result.recovered).toBe(0);
    });
  });
});
