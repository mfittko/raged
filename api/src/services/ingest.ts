import { randomUUID } from "node:crypto";
import { chunkText } from "../chunking.js";
import { detectDocType, type DocType, type IngestItem } from "../doctype.js";
import { extractTier1 } from "../extractors/index.js";
import { enqueueEnrichment, isEnrichmentEnabled, type EnrichmentTask } from "../redis.js";

export interface IngestRequest {
  collection?: string;
  enrich?: boolean;
  items: IngestItem[];
}

export interface IngestResult {
  ok: true;
  upserted: number;
  enrichment?: {
    enqueued: number;
    docTypes: Record<string, number>;
  };
}

export { type IngestItem };

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

  // Process items in batches to limit memory consumption
  const EMBED_BATCH_SIZE = 500;
  const now = new Date().toISOString();
  
  // Pre-process items to assign stable baseIds and detect metadata
  interface ProcessedItem {
    baseId: string;
    docType: DocType;
    tier1Meta: Record<string, unknown>;
    chunks: string[];
    source: string;
    metadata?: Record<string, unknown>;
  }
  
  const processedItems: ProcessedItem[] = request.items.map((item) => {
    const docType = detectDocType(item);
    return {
      baseId: item.id ?? randomUUID(),
      docType,
      tier1Meta: extractTier1(item, docType),
      chunks: chunkText(item.text),
      source: item.source,
      metadata: item.metadata,
    };
  });
  
  let totalUpserted = 0;

  // Embed and upsert in batches
  for (const procItem of processedItems) {
    for (let batchStart = 0; batchStart < procItem.chunks.length; batchStart += EMBED_BATCH_SIZE) {
      const batchEnd = Math.min(batchStart + EMBED_BATCH_SIZE, procItem.chunks.length);
      const batchChunks = procItem.chunks.slice(batchStart, batchEnd);
      const batchVectors = await deps.embed(batchChunks);

      const batchPoints: QdrantPoint[] = [];
      for (let i = 0; i < batchChunks.length; i++) {
        const chunkIndex = batchStart + i;
        batchPoints.push({
          id: `${procItem.baseId}:${chunkIndex}`,
          vector: batchVectors[i],
          payload: {
            ...(procItem.metadata ?? {}),
            text: batchChunks[i],
            source: procItem.source,
            chunkIndex,
            baseId: procItem.baseId,
            docType: procItem.docType,
            ingestedAt: now,
            enrichmentStatus: shouldEnrich ? "pending" : "none",
            tier1Meta: procItem.tier1Meta,
          },
        });
      }

      await deps.upsert(col, batchPoints);
      totalUpserted += batchPoints.length;
    }
  }

  // Enqueue enrichment tasks
  if (shouldEnrich) {
    const TASK_BATCH_SIZE = 100;
    const tasks: EnrichmentTask[] = [];
    const docTypeCounts: Record<string, number> = {};
    
    // Build tasks from processed items
    for (const procItem of processedItems) {
      docTypeCounts[procItem.docType] = (docTypeCounts[procItem.docType] || 0) + procItem.chunks.length;

      for (let chunkIndex = 0; chunkIndex < procItem.chunks.length; chunkIndex++) {
        tasks.push({
          taskId: randomUUID(),
          qdrantId: `${procItem.baseId}:${chunkIndex}`,
          collection: col,
          docType: procItem.docType,
          baseId: procItem.baseId,
          chunkIndex,
          totalChunks: procItem.chunks.length,
          text: procItem.chunks[chunkIndex],
          source: procItem.source,
          tier1Meta: procItem.tier1Meta,
          attempt: 1,
          enqueuedAt: now,
        });
      }
    }

    // Batch enqueue tasks in groups to avoid overwhelming Redis
    for (let i = 0; i < tasks.length; i += TASK_BATCH_SIZE) {
      const batch = tasks.slice(i, i + TASK_BATCH_SIZE);
      await Promise.all(batch.map(task => enqueueEnrichment(task)));
    }

    return {
      ok: true,
      upserted: totalUpserted,
      enrichment: {
        enqueued: tasks.length,
        docTypes: docTypeCounts,
      },
    };
  }

  return { ok: true, upserted: totalUpserted };
}
