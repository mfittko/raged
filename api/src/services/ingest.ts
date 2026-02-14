import { randomUUID } from "node:crypto";
import { chunkText } from "../chunking.js";

export interface IngestRequest {
  collection?: string;
  items: IngestItem[];
}

export interface IngestItem {
  id?: string;
  text: string;
  source: string;
  metadata?: Record<string, unknown>;
}

export interface IngestResult {
  ok: true;
  upserted: number;
}

export interface QdrantPoint {
  id: string;
  vector: number[];
  payload: Record<string, unknown>;
}

export interface IngestDeps {
  embed: (texts: string[]) => Promise<number[][]>;
  ensureCollection: (name: string) => Promise<void>;
  upsert: (collection: string, points: QdrantPoint[]) => Promise<void>;
  collectionName: (name?: string) => string;
}

export async function ingest(
  request: IngestRequest,
  deps: IngestDeps,
): Promise<IngestResult> {
  const col = deps.collectionName(request.collection);
  await deps.ensureCollection(col);

  const allChunks: string[] = [];
  const chunkInfos: {
    baseId: string;
    chunkIndex: number;
    source: string;
    metadata?: Record<string, unknown>;
  }[] = [];

  for (const item of request.items) {
    const baseId = item.id ?? randomUUID();
    const chunks = chunkText(item.text);

    for (let i = 0; i < chunks.length; i++) {
      allChunks.push(chunks[i]);
      chunkInfos.push({
        baseId,
        chunkIndex: i,
        source: item.source,
        metadata: item.metadata,
      });
    }
  }

  const vectors = await deps.embed(allChunks);

  const points: QdrantPoint[] = [];
  for (let i = 0; i < allChunks.length; i++) {
    const info = chunkInfos[i];
    points.push({
      id: `${info.baseId}:${info.chunkIndex}`,
      vector: vectors[i],
      payload: {
        text: allChunks[i],
        source: info.source,
        chunkIndex: info.chunkIndex,
        ...(info.metadata ?? {}),
      },
    });
  }

  await deps.upsert(col, points);
  return { ok: true, upserted: points.length };
}
