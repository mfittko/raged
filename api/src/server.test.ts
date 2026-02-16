import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildApp } from "./server.js";

// Mock the db module
vi.mock("./db.js", () => ({
  getPool: vi.fn(() => ({
    connect: vi.fn(async () => ({
      query: vi.fn(async (sql: string) => {
        if (sql.includes("RETURNING id")) {
          return { rows: [{ id: "test-doc-id" }] };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    })),
    query: vi.fn(async () => ({ rows: [] })),
  })),
  query: vi.fn(async () => ({ rows: [] })),
  runMigrations: vi.fn(),
  closePool: vi.fn(),
}));

// Mock ollama module
vi.mock("./ollama.js", () => ({
  embed: vi.fn(async (texts: string[]) =>
    texts.map(() => Array(768).fill(0.1))
  ),
}));

describe("API integration tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("GET /healthz", () => {
    it("returns 200 with { ok: true }", async () => {
      const app = buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/healthz",
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      await app.close();
    });
  });

  describe("POST /ingest", () => {
    it("returns 200 with upsert count for valid request", async () => {
      const app = buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/ingest",
        headers: {
          authorization: "Bearer test-token",
        },
        payload: {
          collection: "test-col",
          items: [
            { text: "hello world", source: "test.txt" },
            { text: "foo bar", source: "other.txt" },
          ],
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ok).toBe(true);
      expect(body.upserted).toBeGreaterThan(0);
      await app.close();
    });

    it("returns 400 for missing items", async () => {
      const app = buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/ingest",
        headers: {
          authorization: "Bearer test-token",
        },
        payload: {
          collection: "test-col",
        },
      });

      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it("returns 400 for empty items array", async () => {
      const app = buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/ingest",
        headers: {
          authorization: "Bearer test-token",
        },
        payload: {
          collection: "test-col",
          items: [],
        },
      });

      expect(res.statusCode).toBe(400);
      await app.close();
    });
  });

  describe("POST /query", () => {
    it("returns 200 with results for valid query", async () => {
      const { getPool } = await import("./db.js");
      (getPool as any).mockReturnValueOnce({
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
      });

      const app = buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/query",
        headers: {
          authorization: "Bearer test-token",
        },
        payload: {
          query: "test query",
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ok).toBe(true);
      expect(body.results).toBeDefined();
      await app.close();
    });

    it("returns 400 for missing query", async () => {
      const app = buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/query",
        headers: {
          authorization: "Bearer test-token",
        },
        payload: {},
      });

      expect(res.statusCode).toBe(400);
      await app.close();
    });
  });

  describe("auth integration", () => {
    it("allows /healthz without token", async () => {
      const app = buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/healthz",
      });

      expect(res.statusCode).toBe(200);
      await app.close();
    });

    it("returns 401 for /ingest without token when RAG_API_TOKEN is set", async () => {
      process.env.RAG_API_TOKEN = "secret-token";
      const app = buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/ingest",
        payload: {
          items: [{ text: "test", source: "test.txt" }],
        },
      });

      expect(res.statusCode).toBe(401);
      await app.close();
      delete process.env.RAG_API_TOKEN;
    });

    it("allows /ingest with correct token", async () => {
      process.env.RAG_API_TOKEN = "secret-token";
      const app = buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/ingest",
        headers: {
          authorization: "Bearer secret-token",
        },
        payload: {
          items: [{ text: "test", source: "test.txt" }],
        },
      });

      expect(res.statusCode).toBe(200);
      await app.close();
      delete process.env.RAG_API_TOKEN;
    });
  });

  describe("enrichment endpoints", () => {
    it("GET /enrichment/status/:baseId returns status", async () => {
      const { getPool } = await import("./db.js");
      (getPool as any).mockReturnValueOnce({
        query: vi.fn(async () => ({
          rows: [
            {
              enrichment_status: "enriched",
              enriched_at: new Date().toISOString(),
              tier2_meta: null,
              tier3_meta: null,
            },
          ],
        })),
      });

      const app = buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/enrichment/status/test-base-id",
        headers: {
          authorization: "Bearer test-token",
        },
      });

      expect(res.statusCode).toBe(200);
      await app.close();
    });

    it("GET /enrichment/stats returns stats", async () => {
      const { getPool } = await import("./db.js");
      (getPool as any).mockReturnValueOnce({
        query: vi.fn(async () => ({
          rows: [
            { status: "pending", count: 10 },
          ],
        })),
      });

      const app = buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/enrichment/stats",
        headers: {
          authorization: "Bearer test-token",
        },
      });

      expect(res.statusCode).toBe(200);
      await app.close();
    });

    it("POST /enrichment/enqueue returns enqueue result", async () => {
      const { getPool } = await import("./db.js");
      (getPool as any).mockReturnValueOnce({
        query: vi.fn(async () => ({ rows: [] })),
        connect: vi.fn(async () => ({
          query: vi.fn(async () => ({ rows: [] })),
          release: vi.fn(),
        })),
      });

      const app = buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/enrichment/enqueue",
        headers: {
          authorization: "Bearer test-token",
        },
        payload: {},
      });

      expect(res.statusCode).toBe(200);
      await app.close();
    });
  });

  describe("graph endpoints", () => {
    it("GET /graph/entity/:name returns entity data", async () => {
      const { getPool } = await import("./db.js");
      (getPool as any).mockReturnValueOnce({
        query: vi.fn(async () => ({
          rows: [
            {
              name: "Test Entity",
              type: "person",
              description: "A test entity",
              mention_count: 5,
            },
          ],
        })),
      });

      const app = buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/graph/entity/Test%20Entity",
        headers: {
          authorization: "Bearer test-token",
        },
      });

      expect(res.statusCode).toBe(200);
      await app.close();
    });
  });
});
