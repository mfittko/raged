import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { ingestSchema, querySchema } from "./schemas.js";

describe("ingest schema validation", () => {
  function buildApp() {
    const app = Fastify();
    app.post("/ingest", { schema: ingestSchema }, async () => {
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

  it("rejects item without text", async () => {
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

  it("rejects item without source", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/ingest",
      payload: {
        items: [{ text: "hello" }],
      },
    });
    expect(res.statusCode).toBe(400);
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
