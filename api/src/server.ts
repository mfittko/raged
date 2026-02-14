import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { ensureCollection, qdrant, collectionName } from "./qdrant.js";
import { embed } from "./ollama.js";
import { chunkText } from "./chunking.js";
import { registerAuth } from "./auth.js";

const app = Fastify({ logger: true });
registerAuth(app);

app.get("/healthz", async () => ({ ok: true }));

app.post("/ingest", async (req: any) => {
  const col = collectionName(req.body.collection);
  await ensureCollection(col);

  const points: any[] = [];
  for (const item of req.body.items) {
    const baseId = item.id ?? randomUUID();
    const chunks = chunkText(item.text);
    const vectors = await embed(chunks);

    for (let i = 0; i < chunks.length; i++) {
      points.push({
        id: `${baseId}:${i}`,
        vector: vectors[i],
        payload: { text: chunks[i], source: item.source, chunkIndex: i, ...(item.metadata ?? {}) },
      });
    }
  }
  await qdrant.upsert(col, { wait: true, points });
  return { ok: true, upserted: points.length };
});

app.post("/query", async (req: any) => {
  const col = collectionName(req.body.collection);
  await ensureCollection(col);

  const [vector] = await embed([req.body.query]);
  const topK = req.body.topK ?? 8;

  const res = await qdrant.search(col, { vector, limit: topK, with_payload: true, filter: req.body.filter });
  return { ok: true, results: (res ?? []).map((r: any) => ({
    id: r.id, score: r.score, source: r.payload?.source, text: r.payload?.text, payload: r.payload
  })) };
});

const PORT = Number(process.env.PORT || "8080");
app.listen({ port: PORT, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
