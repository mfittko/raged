import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { registerAuth } from "./auth.js";
import { registerErrorHandler } from "./errors.js";
import { 
  ingestSchema, 
  querySchema, 
  enrichmentStatusSchema, 
  enrichmentEnqueueSchema, 
  graphEntitySchema,
  internalTaskClaimSchema,
  internalTaskResultSchema,
  internalTaskFailSchema,
} from "./schemas.js";
import type { IngestRequest } from "./services/ingest.js";
import { validateIngestRequest } from "./services/ingest-validation.js";
import { ingest } from "./services/ingest.js";
import { query } from "./services/query.js";
import { getEnrichmentStatus, getEnrichmentStats, enqueueEnrichment, clearEnrichmentQueue } from "./services/enrichment.js";
import { claimTask, submitTaskResult, failTask, recoverStaleTasks } from "./services/internal.js";
import { getPool } from "./db.js";

export function buildApp() {
  // Trust proxy only when explicitly enabled via env var for security
  const trustProxy = process.env.TRUST_PROXY === "true";
  const parsedBodyLimit = Number.parseInt(process.env.BODY_LIMIT_BYTES || "10485760", 10);
  const bodyLimit = Number.isFinite(parsedBodyLimit) && parsedBodyLimit > 0 ? parsedBodyLimit : 10485760;
  const app = Fastify({ logger: true, trustProxy, bodyLimit });
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
  }, async (req, reply) => {
    const body = req.body as IngestRequest;
    const result = await ingest(body, body.collection);
    return reply.send(result);
  });

  app.post("/query", { schema: querySchema }, async (req, reply) => {
    const body = req.body as any;
    const result = await query(body, body.collection);
    return reply.send(result);
  });

  // Enrichment endpoints
  app.get("/enrichment/status/:baseId", { schema: enrichmentStatusSchema }, async (req, reply) => {
    const { baseId } = req.params as { baseId: string };
    const { collection } = req.query as { collection?: string };
    const result = await getEnrichmentStatus({ baseId, collection }, collection);
    return reply.send(result);
  });

  app.get("/enrichment/stats", async (req, reply) => {
    const { collection, filter } = req.query as { collection?: string; filter?: string };
    const result = await getEnrichmentStats({ collection, filter });
    return reply.send(result);
  });

  app.post("/enrichment/enqueue", { schema: enrichmentEnqueueSchema }, async (req, reply) => {
    const body = req.body as any;
    const result = await enqueueEnrichment(body, body.collection);
    return reply.send(result);
  });

  app.post("/enrichment/clear", async (req, reply) => {
    const body = req.body as any;
    const result = await clearEnrichmentQueue(body, body.collection);
    return reply.send(result);
  });

  // Graph endpoint
  app.get("/graph/entity/:name", { schema: graphEntitySchema }, async (req, reply) => {
    const { name } = req.params as { name: string };
    const { limit = 100 } = req.query as { limit?: number };
    const pool = getPool();
    
    // Get entity with related entities and relationships
    const entityResult = await pool.query<{
      name: string;
      type: string | null;
      description: string | null;
      mention_count: number;
    }>(
      `SELECT name, type, description, mention_count
       FROM entities
       WHERE name = $1`,
      [name]
    );

    if (entityResult.rows.length === 0) {
      return reply.status(404).send({ error: `Entity not found: ${name}` });
    }

    const entity = entityResult.rows[0];

    // Get relationships (both outgoing and incoming)
    const relationshipsResult = await pool.query<{
      source_name: string;
      target_name: string;
      relationship_type: string;
      description: string | null;
    }>(
      `SELECT 
        es.name AS source_name,
        et.name AS target_name,
        er.relationship_type,
        er.description
       FROM entity_relationships er
       JOIN entities es ON er.source_id = es.id
       JOIN entities et ON er.target_id = et.id
       WHERE es.name = $1 OR et.name = $1
       ORDER BY er.created_at DESC
       LIMIT $2`,
      [name, limit]
    );

    return reply.send({
      entity: {
        name: entity.name,
        type: entity.type,
        description: entity.description,
        mentionCount: entity.mention_count,
      },
      relationships: relationshipsResult.rows.map((r) => ({
        source: r.source_name,
        target: r.target_name,
        type: r.relationship_type,
        description: r.description,
      })),
    });
  });

  // Internal endpoints for worker communication
  app.post("/internal/tasks/claim", { schema: internalTaskClaimSchema }, async (req, reply) => {
    const body = req.body as any;
    const result = await claimTask(body);
    return reply.send(result);
  });

  app.post("/internal/tasks/:id/result", { schema: internalTaskResultSchema }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as any;
    await submitTaskResult(id, body);
    return reply.send({ ok: true });
  });

  app.post("/internal/tasks/:id/fail", { schema: internalTaskFailSchema }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as any;
    await failTask(id, body);
    return reply.send({ ok: true });
  });

  app.post("/internal/tasks/recover-stale", async (_req, reply) => {
    const result = await recoverStaleTasks();
    return reply.send(result);
  });

  return app;
}
