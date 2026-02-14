import Fastify from "fastify";
import { ensureCollection, qdrant, collectionName } from "./qdrant.js";
import { embed } from "./ollama.js";
import { registerAuth } from "./auth.js";
import { registerErrorHandler } from "./errors.js";
import { ingest } from "./services/ingest.js";
import { query } from "./services/query.js";
import { ingestSchema, querySchema } from "./schemas.js";
import type { IngestRequest } from "./services/ingest.js";
import type { QueryRequest } from "./services/query.js";

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
    });
  });

  return app;
}

const PORT = Number(process.env.PORT || "8080");
const app = buildApp();
app.listen({ port: PORT, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
