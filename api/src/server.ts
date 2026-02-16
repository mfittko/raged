import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { registerAuth } from "./auth.js";
import { registerErrorHandler } from "./errors.js";
import { ingestSchema, querySchema, enrichmentStatusSchema, enrichmentEnqueueSchema, graphEntitySchema } from "./schemas.js";
import type { IngestRequest } from "./services/ingest.js";
import { validateIngestRequest } from "./services/ingest-validation.js";

export function buildApp() {
  // Trust proxy only when explicitly enabled via env var for security
  const trustProxy = process.env.TRUST_PROXY === "true";
  const app = Fastify({ logger: true, trustProxy });
  registerErrorHandler(app);
  
  // Register CORS with env-configurable origin(s)
  // Default to false (disabled) for security - must be explicitly configured in production
  // Supports comma-separated list of origins
  const rawCorsOrigin = process.env.CORS_ORIGIN;
  let corsOrigin: string | string[] | boolean = false;
  if (rawCorsOrigin) {
    const origins = rawCorsOrigin
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (origins.length === 1) {
      corsOrigin = origins[0];
    } else if (origins.length > 1) {
      corsOrigin = origins;
    }
  }
  app.register(cors, {
    origin: corsOrigin,
  });

  // Health check endpoint - registered before rate limiting to avoid rate limit issues
  app.get("/healthz", async () => ({ ok: true }));

  // Register rate limiting with env-configurable max
  // Validate input to prevent NaN from malformed env values
  const parsed = parseInt(process.env.RATE_LIMIT_MAX || "100", 10);
  const rateLimitMax = Number.isFinite(parsed) && parsed > 0 ? parsed : 100;
  app.register(rateLimit, {
    max: rateLimitMax,
    timeWindow: "1 minute",
  });

  registerAuth(app);

  app.post("/ingest", { 
    schema: ingestSchema,
    preValidation: async (req, reply) => {
      const body = req.body as IngestRequest;
      const validationError = validateIngestRequest(body);
      if (validationError) {
        return reply.status(400).send(validationError);
      }
    }
  }, async (_req, reply) => {
    // TODO: Implement with Postgres in subsequent PR
    return reply.status(501).send({ error: "Not implemented - pending Postgres migration" });
  });

  app.post("/query", { schema: querySchema }, async (_req, reply) => {
    // TODO: Implement with Postgres in subsequent PR
    return reply.status(501).send({ error: "Not implemented - pending Postgres migration" });
  });

  // Enrichment endpoints
  app.get("/enrichment/status/:baseId", { schema: enrichmentStatusSchema }, async (_req, reply) => {
    // TODO: Implement with Postgres in subsequent PR
    return reply.status(501).send({ error: "Not implemented - pending Postgres migration" });
  });

  app.get("/enrichment/stats", async (_req, reply) => {
    // TODO: Implement with Postgres in subsequent PR
    return reply.status(501).send({ error: "Not implemented - pending Postgres migration" });
  });

  app.post("/enrichment/enqueue", { schema: enrichmentEnqueueSchema }, async (_req, reply) => {
    // TODO: Implement with Postgres in subsequent PR
    return reply.status(501).send({ error: "Not implemented - pending Postgres migration" });
  });

  // Graph endpoint
  app.get("/graph/entity/:name", { schema: graphEntitySchema }, async (_req, reply) => {
    // TODO: Implement with Postgres in subsequent PR
    return reply.status(501).send({ error: "Not implemented - pending Postgres migration" });
  });

  return app;
}
