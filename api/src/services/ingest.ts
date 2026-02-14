import { randomUUID } from "node:crypto";
import { chunkText } from "../chunking.js";
import { detectDocType, type DocType } from "../doctype.js";
import { extractTier1 } from "../extractors/index.js";
import { enqueueEnrichment, isEnrichmentEnabled } from "../redis.js";

export interface IngestRequest {
  collection?: string;
  enrich?: boolean;
  items: IngestItem[];
}

export interface IngestItem {
  id?: string;
  text: string;
  source: string;
  docType?: DocType;
  metadata?: Record<string, unknown>;
}

export interface IngestResult {
  ok: true;
  upserted: number;
  enrichment?: {
    enqueued: number;
    docTypes: Record<string, number>;
  };
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

  const shouldEnrich =
    request.enrich !== false && isEnrichmentEnabled();
  const enrichmentTasks: Array<{
    docType: string;
    baseId: string;
    tier1Meta: Record<string, unknown>;
  }> = [];

  const allChunks: string[] = [];
  const chunkInfos: {
    baseId: string;
    chunkIndex: number;
    totalChunks: number;
    source: string;
    docType: string;
    tier1Meta: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  }[] = [];

  for (const item of request.items) {
    const baseId = item.id ?? randomUUID();
    const docType = detectDocType(item);
    const tier1Meta = extractTier1(item, docType);
    const chunks = chunkText(item.text);

    for (let i = 0; i < chunks.length; i++) {
      allChunks.push(chunks[i]);
      chunkInfos.push({
        baseId,
        chunkIndex: i,
        totalChunks: chunks.length,
        source: item.source,
        docType,
        tier1Meta,
        metadata: item.metadata,
      });
    }

    // Track for enrichment if enabled
    if (shouldEnrich) {
      enrichmentTasks.push({ docType, baseId, tier1Meta });
    }
  }

  const vectors = await deps.embed(allChunks);

  const points: QdrantPoint[] = [];
  // Use single timestamp for all chunks in this batch for consistency
  const now = new Date().toISOString();

  for (let i = 0; i < allChunks.length; i++) {
    const info = chunkInfos[i];
    points.push({
      id: `${info.baseId}:${info.chunkIndex}`,
      vector: vectors[i],
      payload: {
        ...(info.metadata ?? {}),
        text: allChunks[i],
        source: info.source,
        chunkIndex: info.chunkIndex,
        docType: info.docType,
        ingestedAt: now,
        enrichmentStatus: shouldEnrich ? "pending" : "none",
        tier1Meta: info.tier1Meta,
      },
    });
  }

  await deps.upsert(col, points);

  // Enqueue enrichment tasks
  if (shouldEnrich) {
    for (let i = 0; i < allChunks.length; i++) {
      const info = chunkInfos[i];
      await enqueueEnrichment({
        taskId: randomUUID(),
        qdrantId: `${info.baseId}:${info.chunkIndex}`,
        collection: col,
        docType: info.docType,
        baseId: info.baseId,
        chunkIndex: info.chunkIndex,
        totalChunks: info.totalChunks,
        text: allChunks[i],
        source: info.source,
        tier1Meta: info.tier1Meta,
        attempt: 1,
        enqueuedAt: now,
      });
    }

    // Compute enrichment stats
    const docTypeCounts: Record<string, number> = {};
    for (const task of enrichmentTasks) {
      docTypeCounts[task.docType] = (docTypeCounts[task.docType] || 0) + 1;
    }

    return {
      ok: true,
      upserted: points.length,
      enrichment: {
        enqueued: allChunks.length,
        docTypes: docTypeCounts,
      },
    };
  }

  return { ok: true, upserted: points.length };
}
