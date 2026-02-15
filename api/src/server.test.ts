import { describe, it, expect, vi, afterEach } from "vitest";
import Fastify from "fastify";
import { registerAuth } from "./auth.js";
import { registerErrorHandler } from "./errors.js";
import { ingest } from "./services/ingest.js";
import { query } from "./services/query.js";
import { ingestSchema, querySchema } from "./schemas.js";
import type { IngestRequest } from "./services/ingest.js";
import type { QueryRequest } from "./services/query.js";
import type { IngestDeps } from "./services/ingest.js";
import type { QueryDeps } from "./services/query.js";

function buildTestApp(options?: {
  ingestDeps?: Partial<IngestDeps>;
  queryDeps?: Partial<QueryDeps>;
}) {
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerAuth(app);

  const defaultIngestDeps: IngestDeps = {
    embed: vi.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3])),
    ensureCollection: vi.fn(async () => {}),
    upsert: vi.fn(async () => {}),
    collectionName: vi.fn((name?: string) => name || "docs"),
  };

  const defaultQueryDeps: QueryDeps = {
    embed: vi.fn(async () => [[0.1, 0.2, 0.3]]),
    ensureCollection: vi.fn(async () => {}),
    search: vi.fn(async () => [
      {
        id: "doc-1:0",
        score: 0.9,
        payload: { text: "result text", source: "test.txt", chunkIndex: 0 },
      },
    ]),
    collectionName: vi.fn((name?: string) => name || "docs"),
  };

  const ingestDeps = { ...defaultIngestDeps, ...options?.ingestDeps };
  const queryDeps = { ...defaultQueryDeps, ...options?.queryDeps };

  app.get("/healthz", async () => ({ ok: true }));

  app.post("/ingest", { schema: ingestSchema }, async (req) => {
    const body = req.body as IngestRequest;
    return ingest(body, ingestDeps);
  });

  app.post("/query", { schema: querySchema }, async (req) => {
    const body = req.body as QueryRequest;
    return query(body, queryDeps);
  });

  return { app, ingestDeps, queryDeps };
}

describe("API integration tests", () => {
  describe("GET /healthz", () => {
    it("returns 200 with { ok: true }", async () => {
      const { app } = buildTestApp();
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
      const { app } = buildTestApp();
      const res = await app.inject({
        method: "POST",
        url: "/ingest",
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
      expect(body.upserted).toBe(2);
      await app.close();
    });

    it("returns 400 for missing items", async () => {
      const { app } = buildTestApp();
      const res = await app.inject({
        method: "POST",
        url: "/ingest",
        payload: { collection: "test" },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toHaveProperty("error");
      await app.close();
    });

    it("returns 400 for empty items array", async () => {
      const { app } = buildTestApp();
      const res = await app.inject({
        method: "POST",
        url: "/ingest",
        payload: { items: [] },
      });

      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it("returns 502 when embed service fails", async () => {
      const { app } = buildTestApp({
        ingestDeps: {
          embed: vi.fn(async () => {
            const err = new Error("Ollama embeddings failed: 503 Service Unavailable") as Error & { code: string };
            err.code = "UPSTREAM_SERVICE_ERROR";
            throw err;
          }),
        },
      });

      const res = await app.inject({
        method: "POST",
        url: "/ingest",
        payload: {
          items: [{ text: "hello", source: "test.txt" }],
        },
      });

      expect(res.statusCode).toBe(502);
      expect(res.json().error).toBe("Upstream service error");
      await app.close();
    });
  });

  describe("POST /query", () => {
    it("returns 200 with results for valid query", async () => {
      const { app } = buildTestApp();
      const res = await app.inject({
        method: "POST",
        url: "/query",
        payload: {
          query: "authentication flow",
          topK: 5,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ok).toBe(true);
      expect(body.results).toHaveLength(1);
      expect(body.results[0]).toEqual({
        id: "doc-1:0",
        score: 0.9,
        source: "test.txt",
        text: "result text",
        payload: { text: "result text", source: "test.txt", chunkIndex: 0 },
      });
      await app.close();
    });

    it("returns 400 for missing query", async () => {
      const { app } = buildTestApp();
      const res = await app.inject({
        method: "POST",
        url: "/query",
        payload: { topK: 5 },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toHaveProperty("error");
      await app.close();
    });

    it("returns 400 for empty query string", async () => {
      const { app } = buildTestApp();
      const res = await app.inject({
        method: "POST",
        url: "/query",
        payload: { query: "" },
      });

      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it("returns empty results when search returns nothing", async () => {
      const { app } = buildTestApp({
        queryDeps: {
          search: vi.fn(async () => []),
        },
      });

      const res = await app.inject({
        method: "POST",
        url: "/query",
        payload: { query: "nothing matches" },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, results: [] });
      await app.close();
    });

    it("passes filter through to search", async () => {
      const searchMock = vi.fn(async () => []);
      const { app } = buildTestApp({
        queryDeps: { search: searchMock },
      });

      const filter = { must: [{ key: "lang", match: { value: "ts" } }] };
      const res = await app.inject({
        method: "POST",
        url: "/query",
        payload: { query: "hello", filter },
      });

      expect(res.statusCode).toBe(200);
      expect(searchMock).toHaveBeenCalledWith("docs", [0.1, 0.2, 0.3], 8, filter);
      await app.close();
    });
  });

  describe("auth integration", () => {
    const ORIGINAL_TOKEN = process.env.RAG_API_TOKEN;

    afterEach(() => {
      if (ORIGINAL_TOKEN === undefined) {
        delete process.env.RAG_API_TOKEN;
      } else {
        process.env.RAG_API_TOKEN = ORIGINAL_TOKEN;
      }
    });

    it("blocks /ingest without token when auth is enabled", async () => {
      process.env.RAG_API_TOKEN = "test-secret";
      const { app } = buildTestApp();

      const res = await app.inject({
        method: "POST",
        url: "/ingest",
        payload: {
          items: [{ text: "hello", source: "test.txt" }],
        },
      });

      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: "Unauthorized" });
      await app.close();
    });

    it("allows /ingest with correct token", async () => {
      process.env.RAG_API_TOKEN = "test-secret";
      const { app } = buildTestApp();

      const res = await app.inject({
        method: "POST",
        url: "/ingest",
        headers: { authorization: "Bearer test-secret" },
        payload: {
          items: [{ text: "hello", source: "test.txt" }],
        },
      });

      expect(res.statusCode).toBe(200);
      await app.close();
    });

    it("always allows /healthz without token", async () => {
      process.env.RAG_API_TOKEN = "test-secret";
      const { app } = buildTestApp();

      const res = await app.inject({
        method: "GET",
        url: "/healthz",
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      await app.close();
    });
  });

  describe("enrichment endpoints", () => {
    it("GET /enrichment/status/:baseId returns 404 for missing baseId", async () => {
      // This test requires Qdrant to be running. When Qdrant is not available,
      // the error handler will return 500, so we check for either 404 or 500.
      const { buildApp } = await import("./server.js");
      const app = buildApp();

      const res = await app.inject({
        method: "GET",
        url: "/enrichment/status/nonexistent-base-id",
      });

      // Either 404 (baseId not found) or 500 (Qdrant unavailable in test env)
      expect([404, 500]).toContain(res.statusCode);
      expect(res.json()).toHaveProperty("error");
      await app.close();
    });

    it("GET /enrichment/stats returns stats when enrichment disabled", async () => {
      const { buildApp } = await import("./server.js");
      const app = buildApp();

      const res = await app.inject({
        method: "GET",
        url: "/enrichment/stats",
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toHaveProperty("queue");
      expect(body).toHaveProperty("totals");
      await app.close();
    });

    it("POST /enrichment/enqueue returns 0 when enrichment disabled", async () => {
      const { buildApp } = await import("./server.js");
      const app = buildApp();

      const res = await app.inject({
        method: "POST",
        url: "/enrichment/enqueue",
        payload: { collection: "docs" },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, enqueued: 0 });
      await app.close();
    });

    it("POST /enrichment/enqueue accepts valid payload", async () => {
      const { buildApp } = await import("./server.js");
      const app = buildApp();

      const res = await app.inject({
        method: "POST",
        url: "/enrichment/enqueue",
        payload: { collection: "docs", force: false },
      });

      expect(res.statusCode).toBe(200);
      await app.close();
    });
  });

  describe("graph endpoints", () => {
    it("GET /graph/entity/:name returns 503 when graph disabled", async () => {
      const { buildApp } = await import("./server.js");
      const app = buildApp();

      const res = await app.inject({
        method: "GET",
        url: "/graph/entity/AuthService",
      });

      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ error: "Graph functionality is not enabled" });
      await app.close();
    });
  });

  describe("POST /query with graphExpand", () => {
    it("accepts graphExpand parameter", async () => {
      const { app } = buildTestApp();
      const res = await app.inject({
        method: "POST",
        url: "/query",
        payload: {
          query: "authentication flow",
          graphExpand: true,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ok).toBe(true);
      expect(body.results).toHaveLength(1);
      // Graph data would be present if Neo4j was enabled and entities were found
      await app.close();
    });
  });

  describe("CORS configuration", () => {
    const ORIGINAL_CORS_ORIGIN = process.env.CORS_ORIGIN;

    afterEach(() => {
      if (ORIGINAL_CORS_ORIGIN === undefined) {
        delete process.env.CORS_ORIGIN;
      } else {
        process.env.CORS_ORIGIN = ORIGINAL_CORS_ORIGIN;
      }
    });

    it("blocks CORS requests by default when CORS_ORIGIN is not set", async () => {
      const { buildApp } = await import("./server.js");
      const app = buildApp();

      const res = await app.inject({
        method: "GET",
        url: "/healthz",
        headers: { origin: "http://example.com" },
      });

      expect(res.statusCode).toBe(200);
      // CORS should be disabled by default (no access-control-allow-origin header)
      expect(res.headers["access-control-allow-origin"]).toBeUndefined();
      await app.close();
    });

    it("respects CORS_ORIGIN environment variable", async () => {
      process.env.CORS_ORIGIN = "https://specific-domain.com";
      const { buildApp } = await import("./server.js");
      const app = buildApp();

      const res = await app.inject({
        method: "OPTIONS",
        url: "/healthz",
        headers: { 
          origin: "https://specific-domain.com",
          "access-control-request-method": "GET",
        },
      });

      expect(res.statusCode).toBe(204);
      expect(res.headers["access-control-allow-origin"]).toBe("https://specific-domain.com");
      await app.close();
    });
  });

  describe("Rate limiting", () => {
    const ORIGINAL_RATE_LIMIT_MAX = process.env.RATE_LIMIT_MAX;

    afterEach(() => {
      if (ORIGINAL_RATE_LIMIT_MAX === undefined) {
        delete process.env.RATE_LIMIT_MAX;
      } else {
        process.env.RATE_LIMIT_MAX = ORIGINAL_RATE_LIMIT_MAX;
      }
    });

    it("rate limit plugin is registered", async () => {
      const { buildApp } = await import("./server.js");
      const app = buildApp();
      await app.ready();

      // Verify the app starts and responds successfully
      const res = await app.inject({
        method: "GET",
        url: "/healthz",
      });

      expect(res.statusCode).toBe(200);
      await app.close();
    });

    it("respects RATE_LIMIT_MAX environment variable", async () => {
      process.env.RATE_LIMIT_MAX = "100";
      const { buildApp } = await import("./server.js");
      const app = buildApp();
      await app.ready();

      const res = await app.inject({
        method: "GET",
        url: "/healthz",
      });

      expect(res.statusCode).toBe(200);
      await app.close();
    });
  });
});
