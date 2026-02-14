import Fastify from "fastify";
import { ensureCollection, qdrant, collectionName, getPointsByBaseId, scrollPoints, scrollPointsPage, getPointsByIds } from "./qdrant.js";
import { embed } from "./ollama.js";
import { registerAuth } from "./auth.js";
import { registerErrorHandler } from "./errors.js";
import { ingest } from "./services/ingest.js";
import { query } from "./services/query.js";
import { getEnrichmentStatus, getEnrichmentStats, enqueueEnrichment as enqueueEnrichmentService } from "./services/enrichment.js";
import { ingestSchema, querySchema, enrichmentStatusSchema, enrichmentEnqueueSchema, graphEntitySchema } from "./schemas.js";
import type { IngestRequest } from "./services/ingest.js";
import type { QueryRequest } from "./services/query.js";
import type { EnrichmentStatusRequest, EnqueueRequest } from "./services/enrichment.js";
import { isEnrichmentEnabled, getQueueLength, enqueueEnrichment as enqueueTask } from "./redis.js";
import { isGraphEnabled, expandEntities, getEntity, getDocumentsByEntityMention } from "./graph-client.js";

export function buildApp() {
  const app = Fastify({ logger: true });
  registerErrorHandler(app);
  registerAuth(app);

  app.get("/healthz", async () => ({ ok: true }));

  app.post("/ingest", { schema: ingestSchema }, async (req) => {
    const body = req.body as IngestRequest;
    return ingest(body, {
      embed,
      ensureCollection,
      upsert: async (collection, points) => {
        await qdrant.upsert(collection, { wait: true, points });
      },
      collectionName,
    });
  });

  app.post("/query", { schema: querySchema }, async (req) => {
    const body = req.body as QueryRequest;
    return query(body, {
      embed,
      ensureCollection,
      search: async (collection, vector, limit, filter) => {
        const res = await qdrant.search(collection, {
          vector,
          limit,
          with_payload: true,
          filter,
        });
        return (res ?? []).map((r) => ({
          id: r.id,
          score: r.score,
          payload: r.payload as Record<string, unknown> | undefined,
        }));
      },
      collectionName,
      expandEntities: isGraphEnabled() ? expandEntities : undefined,
    });
  });

  // Enrichment endpoints
  app.get("/enrichment/status/:baseId", { schema: enrichmentStatusSchema }, async (req) => {
    const params = req.params as { baseId: string };
    const query = req.query as { collection?: string };
    const request: EnrichmentStatusRequest = {
      baseId: params.baseId,
      collection: query.collection,
    };
    return getEnrichmentStatus(request, {
      collectionName,
      getPointsByBaseId: async (collection, baseId) => {
        return getPointsByBaseId(collection, baseId);
      },
      scrollPointsPage,
      scrollPoints,
      getQueueLength,
      enqueueTask,
    });
  });

  app.get("/enrichment/stats", async () => {
    if (!isEnrichmentEnabled()) {
      return {
        queue: { pending: 0, processing: 0, deadLetter: 0 },
        totals: { enriched: 0, failed: 0, pending: 0, processing: 0, none: 0 },
      };
    }
    return getEnrichmentStats({
      collectionName,
      scrollPointsPage,
      getQueueLength,
    });
  });

  app.post("/enrichment/enqueue", { schema: enrichmentEnqueueSchema }, async (req) => {
    if (!isEnrichmentEnabled()) {
      return { ok: true, enqueued: 0 };
    }
    const body = req.body as EnqueueRequest;
    return enqueueEnrichmentService(body, {
      collectionName,
      getPointsByBaseId,
      scrollPointsPage,
      scrollPoints,
      getQueueLength,
      enqueueTask,
    });
  });

  // Graph endpoint
  app.get("/graph/entity/:name", { schema: graphEntitySchema }, async (req, reply) => {
    const params = req.params as { name: string };
    if (!isGraphEnabled()) {
      return reply.status(503).send({ error: "Graph functionality is not enabled" });
    }

    const entityDetails = await getEntity(params.name);
    if (!entityDetails) {
      return reply.status(404).send({ error: "Entity not found" });
    }

    // Get documents that mention this entity
    const documentIds = await getDocumentsByEntityMention(params.name);

    return {
      entity: entityDetails.entity,
      connections: entityDetails.connections,
      documents: documentIds.map(id => ({ id })),
    };
  });

  return app;
}
