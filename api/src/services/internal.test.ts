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

    it("stores summary on document and omits summary from chunk tier3 metadata", async () => {
      const { getPool } = await import("../db.js");
      const queryMock = vi.fn(async (sql: string) => {
        if (sql.includes("SELECT id FROM documents")) {
          return { rows: [{ id: "doc-123" }] };
        }
        return { rows: [] };
      });

      (getPool as any).mockReturnValueOnce({
        connect: vi.fn(async () => ({
          query: queryMock,
          release: vi.fn(),
        })),
      });

      await expect(
        submitTaskResult("task-123", {
          chunkId: "base-id:0",
          collection: "docs",
          tier3: { summary: "ok" },
        })
      ).resolves.not.toThrow();

      expect(queryMock).toHaveBeenCalledWith(
        expect.stringContaining("COALESCE(c.tier3_meta, '{}'::jsonb) || $2::jsonb"),
        [null, null, "base-id", "docs", 0]
      );

      expect(queryMock).toHaveBeenCalledWith(
        expect.stringContaining("SET summary_short = COALESCE($1, summary_short)"),
        [null, "ok", null, "base-id", "docs"]
      );
    });
  });

  describe("failTask", () => {
    it("records chunk failure metadata and schedules retry", async () => {
      const { getPool } = await import("../db.js");
      const queryMock = vi.fn(async (sql: string) => {
        if (sql.includes("SELECT attempt, max_attempts, payload")) {
          return {
            rows: [
              {
                attempt: 1,
                max_attempts: 3,
                payload: {
                  baseId: "base-id",
                  collection: "docs",
                  chunkIndex: 0,
                },
              },
            ],
          };
        }
        return { rows: [] };
      });

      (getPool as any).mockReturnValueOnce({
        connect: vi.fn(async () => ({
          query: queryMock,
          release: vi.fn(),
        })),
      });

      await expect(
        failTask("task-123", { error: "Test error" })
      ).resolves.not.toThrow();

      expect(queryMock).toHaveBeenCalledWith(
        expect.stringContaining("SET enrichment_status = 'failed'"),
        ["base-id", "docs", 0, "Test error", "task-123", 1, 3, false]
      );
      expect(queryMock).toHaveBeenCalledWith(
        expect.stringContaining("SET status = 'pending'"),
        ["Test error", 60, "task-123"]
      );
    });

    it("records chunk failure metadata and moves to dead letter after max attempts", async () => {
      const { getPool } = await import("../db.js");
      const queryMock = vi.fn(async (sql: string) => {
        if (sql.includes("SELECT attempt, max_attempts, payload")) {
          return {
            rows: [
              {
                attempt: 3,
                max_attempts: 3,
                payload: {
                  baseId: "base-id",
                  collection: "docs",
                  chunkId: "base-id:0",
                },
              },
            ],
          };
        }
        return { rows: [] };
      });

      (getPool as any).mockReturnValueOnce({
        connect: vi.fn(async () => ({
          query: queryMock,
          release: vi.fn(),
        })),
      });

      await expect(
        failTask("task-123", { error: "Final attempt failed" })
      ).resolves.not.toThrow();

      expect(queryMock).toHaveBeenCalledWith(
        expect.stringContaining("SET enrichment_status = 'failed'"),
        ["base-id", "docs", 0, "Final attempt failed", "task-123", 3, 3, true]
      );
      expect(queryMock).toHaveBeenCalledWith(
        expect.stringContaining("SET status = 'dead'"),
        ["Final attempt failed", "task-123"]
      );
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
