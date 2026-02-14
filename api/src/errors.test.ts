import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { registerErrorHandler } from "./errors.js";

describe("registerErrorHandler", () => {
  it("returns 400 with structured error for validation failures", async () => {
    const app = Fastify();
    registerErrorHandler(app);
    app.post(
      "/test",
      {
        schema: {
          body: {
            type: "object" as const,
            required: ["name"],
            properties: { name: { type: "string" as const } },
          },
        },
      },
      async () => ({ ok: true }),
    );

    const res = await app.inject({
      method: "POST",
      url: "/test",
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body).toHaveProperty("error");
    expect(body.error).toContain("Validation failed");
    await app.close();
  });

  it("returns 502 for upstream service errors with UPSTREAM_SERVICE_ERROR code", async () => {
    const app = Fastify();
    registerErrorHandler(app);
    app.get("/test", async () => {
      const err = new Error("Ollama connection refused") as Error & { code: string };
      err.code = "UPSTREAM_SERVICE_ERROR";
      throw err;
    });

    const res = await app.inject({
      method: "GET",
      url: "/test",
    });

    expect(res.statusCode).toBe(502);
    const body = res.json();
    expect(body).toEqual({
      error: "Upstream service error: Ollama connection refused",
    });
    await app.close();
  });

  it("returns 502 for upstream service errors with UpstreamServiceError name", async () => {
    const app = Fastify();
    registerErrorHandler(app);
    app.get("/test", async () => {
      const err = new Error("Qdrant unavailable");
      err.name = "UpstreamServiceError";
      throw err;
    });

    const res = await app.inject({
      method: "GET",
      url: "/test",
    });

    expect(res.statusCode).toBe(502);
    const body = res.json();
    expect(body).toEqual({
      error: "Upstream service error: Qdrant unavailable",
    });
    await app.close();
  });

  it("returns 500 with generic message for internal errors", async () => {
    const app = Fastify({ logger: false }); // Disable logging for test
    registerErrorHandler(app);
    app.get("/test", async () => {
      throw new Error("Something went wrong internally");
    });

    const res = await app.inject({
      method: "GET",
      url: "/test",
    });

    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body).toEqual({
      error: "Internal server error",
    });
    await app.close();
  });

  it("preserves custom status codes from 4xx errors", async () => {
    const app = Fastify();
    registerErrorHandler(app);
    app.get("/test", async (_req, reply) => {
      return reply.code(404).send({ error: "Not found" });
    });

    const res = await app.inject({
      method: "GET",
      url: "/test",
    });

    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
