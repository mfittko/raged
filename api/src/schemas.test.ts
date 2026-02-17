import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { ingestSchema, querySchema } from "./schemas.js";
import type { IngestRequest } from "./services/ingest.js";
import { validateIngestRequest } from "./services/ingest-validation.js";

describe("ingest schema validation", () => {
  function buildApp() {
    const app = Fastify();
    app.post("/ingest", {
      schema: ingestSchema,
      preValidation: async (req, reply) => {
        const body = req.body as IngestRequest;
        const validationError = validateIngestRequest(body);
        if (validationError) {
          return reply.status(400).send(validationError);
        }
      }
    }, async () => {
      return { ok: true };
    });
    return app;
  }

  it("rejects request without items", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/ingest",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("rejects request with empty items array", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/ingest",
      payload: { items: [] },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("accepts item with only URL (no text)", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/ingest",
      payload: {
        items: [{ url: "https://example.com/doc" }],
      },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("accepts item without source when URL is provided", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/ingest",
      payload: {
        items: [{ url: "https://example.com/doc" }],
      },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("rejects item with empty text", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/ingest",
      payload: {
        items: [{ text: "", source: "test.txt" }],
      },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("accepts valid ingest request", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/ingest",
      payload: {
        items: [{ text: "hello world", source: "test.txt" }],
      },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("accepts valid ingest request with optional fields", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/ingest",
      payload: {
        collection: "my-col",
        items: [
          {
            id: "doc-1",
            text: "hello world",
            source: "test.txt",
            metadata: { lang: "en" },
          },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("accepts overwrite flag for ingest", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/ingest",
      payload: {
        overwrite: true,
        items: [{ text: "hello world", source: "test.txt" }],
      },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("rejects non-boolean overwrite flag", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/ingest",
      payload: {
        overwrite: "yes",
        items: [{ text: "hello world", source: "test.txt" }],
      },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("accepts URL item without text", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/ingest",
      payload: {
        items: [{ url: "https://example.com/article" }],
      },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("accepts URL item with source", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/ingest",
      payload: {
        items: [{ url: "https://example.com/article", source: "my-source" }],
      },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("accepts URL item with both url and text", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/ingest",
      payload: {
        items: [
          {
            url: "https://example.com/article",
            text: "Pre-provided text",
            source: "my-source",
          },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("rejects item with neither text nor url", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/ingest",
      payload: {
        items: [{ source: "test.txt" }],
      },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("rejects URL with non-HTTP(S) protocol", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/ingest",
      payload: {
        items: [{ url: "ftp://example.com/file" }],
      },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("rejects more than 50 URL items per request", async () => {
    const app = buildApp();
    const items = Array.from({ length: 51 }, (_, i) => ({
      url: `https://example.com/doc-${i}`,
    }));
    const res = await app.inject({
      method: "POST",
      url: "/ingest",
      payload: { items },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toContain("maximum 50 URL items");
    await app.close();
  });

  it("accepts 50 URL items and 950 text items (1000 total)", async () => {
    const app = buildApp();
    const urlItems = Array.from({ length: 50 }, (_, i) => ({
      url: `https://example.com/doc-${i}`,
    }));
    const textItems = Array.from({ length: 950 }, (_, i) => ({
      text: `doc ${i}`,
      source: `test-${i}.txt`,
    }));
    const res = await app.inject({
      method: "POST",
      url: "/ingest",
      payload: { items: [...urlItems, ...textItems] },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("rejects request with more than 1000 items", async () => {
    const app = buildApp();
    const items = Array.from({ length: 1001 }, (_, i) => ({
      text: `doc ${i}`,
      source: `test-${i}.txt`,
    }));
    const res = await app.inject({
      method: "POST",
      url: "/ingest",
      payload: { items },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe("query schema validation", () => {
  function buildApp() {
    const app = Fastify();
    app.post("/query", { schema: querySchema }, async () => {
      return { ok: true };
    });
    return app;
  }

  it("rejects request without query", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/query",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("rejects request with empty query string", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/query",
      payload: { query: "" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("rejects topK of 0", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/query",
      payload: { query: "hello", topK: 0 },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("rejects topK over 100", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/query",
      payload: { query: "hello", topK: 200 },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("accepts valid query request", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/query",
      payload: { query: "authentication flow" },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("accepts valid query request with all optional fields", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/query",
      payload: {
        collection: "my-col",
        query: "auth flow",
        topK: 5,
        filter: { must: [{ key: "lang", match: { value: "ts" } }] },
      },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});
