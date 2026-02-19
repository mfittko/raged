import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { registerAuth } from "./auth.js";
import { registerErrorHandler } from "./errors.js";
import { 
  ingestSchema, 
  querySchema, 
  queryDownloadFirstSchema,
  enrichmentStatusSchema, 
  enrichmentStatsSchema,
  enrichmentEnqueueSchema, 
  enrichmentClearSchema,
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
import { listCollections } from "./services/collections.js";
import { claimTask, submitTaskResult, failTask, recoverStaleTasks } from "./services/internal.js";
import { getPool } from "./db.js";
import { downloadRawBlobStream } from "./blob-store.js";
import path from "node:path";
import type { Readable } from "node:stream";

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

  function deriveFileName(source: string, mimeType: string): string {
    let pathLike = source;
    try {
      const url = new URL(source);
      if (url.pathname) {
        pathLike = url.pathname;
      }
    } catch {
      // Not a URL; treat source as plain path/identifier
    }

    const segments = pathLike.split("/").filter((segment) => segment.length > 0);
    const candidate = segments.length > 0 ? segments[segments.length - 1] : "download";
    let sanitized = candidate.replace(/[\x00-\x1f\x7f"]/g, "_");
    if (sanitized.length === 0 || sanitized === "." || sanitized === "..") {
      sanitized = "download";
    }

    if (path.extname(sanitized).length > 0) {
      return sanitized;
    }
    const mimeToExt: Record<string, string> = {
      "application/pdf": ".pdf",
      "text/html": ".html",
      "text/plain": ".txt",
      "text/markdown": ".md",
      "application/json": ".json",
      "image/png": ".png",
      "image/jpeg": ".jpg",
      "image/gif": ".gif",
      "image/webp": ".webp",
    };
    const ext = mimeToExt[mimeType] ?? ".bin";
    return `${sanitized}${ext}`;
  }

  app.post("/query/download-first", { schema: queryDownloadFirstSchema }, async (req, reply) => {
    const body = req.body as any;
    const queryResult = await query(body, body.collection);
    const first = queryResult.results[0];
    if (!first) {
      return reply.status(404).send({ error: "No results found for query" });
    }

    const baseId = first.payload?.baseId as string | undefined;
    if (!baseId) {
      return reply.status(404).send({ error: "Result has no baseId" });
    }

    const col = body.collection || "docs";
    const pool = getPool();
    const docResult = await pool.query<{
      raw_data: Buffer | null;
      raw_key: string | null;
      source: string;
      mime_type: string | null;
    }>(
      `SELECT raw_data, raw_key, source, mime_type FROM documents WHERE base_id = $1 AND collection = $2 LIMIT 1`,
      [baseId, col]
    );

    const doc = docResult.rows[0];
    if (!doc) {
      return reply.status(404).send({ error: `Document not found: ${baseId}` });
    }

    let responseBody: Buffer | Readable;
    if (doc.raw_data !== null) {
      responseBody = doc.raw_data;
    } else if (doc.raw_key) {
      try {
        const blob = await downloadRawBlobStream(doc.raw_key);
        responseBody = blob.stream;
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        return reply.status(502).send({ error: `Failed to retrieve document from blob store: ${message}` });
      }
    } else {
      return reply.status(404).send({ error: "No raw data available for document" });
    }

    const mimeType = doc.mime_type || "application/octet-stream";
    const fileName = deriveFileName(doc.source, mimeType);
    const safeSource = doc.source.replace(/[\x00-\x1f\x7f]/g, "_");

    return reply
      .header("Content-Type", mimeType)
      .header("Content-Disposition", `attachment; filename="${fileName}"`)
      .header("X-Raged-Source", safeSource)
      .send(responseBody);
  });

  app.post("/query/fulltext-first", { schema: queryDownloadFirstSchema }, async (req, reply) => {
    const body = req.body as any;
    const queryResult = await query(body, body.collection);
    const first = queryResult.results[0];
    if (!first) {
      return reply.status(404).send({ error: "No results found for query" });
    }

    const baseId = first.payload?.baseId as string | undefined;
    if (!baseId) {
      return reply.status(404).send({ error: "Result has no baseId" });
    }

    const col = body.collection || "docs";
    const pool = getPool();
    const chunksResult = await pool.query<{
      text: string;
      source: string;
    }>(
      `SELECT c.text, d.source
      FROM documents d
      JOIN chunks c ON c.document_id = d.id
      WHERE d.base_id = $1 AND d.collection = $2
      ORDER BY c.chunk_index`,
      [baseId, col]
    );

    if (chunksResult.rows.length === 0) {
      return reply.status(404).send({ error: `No chunks found for document: ${baseId}` });
    }

    const source = chunksResult.rows[0]?.source || baseId;
    const segment = source.split("/").pop() || source;
    const baseName = path.basename(segment.replace(/[\x00-\x1f\x7f"]/g, "_"), path.extname(segment));
    const fullText = chunksResult.rows
      .map((r) => r.text)
      .filter((t) => t && t.trim().length > 0)
      .join("\n\n");
    const safeSource = source.replace(/[\x00-\x1f\x7f]/g, "_");

    return reply
      .header("Content-Type", "text/plain; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="${baseName}.txt"`)
      .header("X-Raged-Source", safeSource)
      .send(fullText);
  });

  // Collections endpoint
  app.get("/collections", async (_req, reply) => {
    const result = await listCollections();
    return reply.send(result);
  });

  // Enrichment endpoints
  app.get("/enrichment/status/:baseId", { schema: enrichmentStatusSchema }, async (req, reply) => {
    const { baseId } = req.params as { baseId: string };
    const { collection } = req.query as { collection?: string };
    const result = await getEnrichmentStatus({ baseId, collection }, collection);
    return reply.send(result);
  });

  app.get("/enrichment/stats", { schema: enrichmentStatsSchema }, async (req, reply) => {
    const { collection, filter } = req.query as { collection?: string; filter?: string };
    const result = await getEnrichmentStats({ collection, filter });
    return reply.send(result);
  });

  app.post("/enrichment/enqueue", { schema: enrichmentEnqueueSchema }, async (req, reply) => {
    const body = req.body as any;
    const result = await enqueueEnrichment(body, body.collection);
    return reply.send(result);
  });

  app.post("/enrichment/clear", { schema: enrichmentClearSchema }, async (req, reply) => {
    const body = req.body as any;
    const collection = typeof body.collection === "string" ? body.collection : undefined;
    const result = await clearEnrichmentQueue(body, collection);
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
