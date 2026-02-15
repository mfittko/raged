import { randomUUID } from "node:crypto";
import { chunkText } from "../chunking.js";
import { detectDocType, type DocType, type IngestItem } from "../doctype.js";
import { extractTier1 } from "../extractors/index.js";
import { enqueueEnrichment, isEnrichmentEnabled, type EnrichmentTask } from "../redis.js";
import { fetchUrls } from "./url-fetch.js";
import { extractContentAsync } from "./url-extract.js";

export interface IngestRequest {
  collection?: string;
  enrich?: boolean;
  items: IngestItem[];
}

export interface IngestResult {
  ok: true;
  upserted: number;
  fetched?: number;
  enrichment?: {
    enqueued: number;
    docTypes: Record<string, number>;
  };
  errors?: Array<{
    url: string;
    status: number | null;
    reason: string;
  }>;
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

function toSourceFromUrl(rawUrl: string): string {
  try {
    const urlObj = new URL(rawUrl);
    return `${urlObj.origin}${urlObj.pathname}`;
  } catch {
    return rawUrl;
  }
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
  
  // Pre-process: partition items into text items and URL items
  const textItems: IngestItem[] = [];
  const urlItems: IngestItem[] = [];
  
  for (const item of request.items) {
    if (item.url && !item.text) {
      urlItems.push(item);
    } else {
      textItems.push(item);
    }
  }
  
  // Fetch and extract content from URLs
  const fetchErrors: Array<{ url: string; status: number | null; reason: string }> = [];
  let fetchedCount = 0;
  
  if (urlItems.length > 0) {
    const urls = urlItems.map(item => item.url!);
    const { results, errors } = await fetchUrls(urls);
    
    // Convert fetch errors to the result format
    for (const error of errors) {
      fetchErrors.push({
        url: error.url,
        status: error.status,
        reason: error.reason,
      });
    }
    
    // Extract content from successful fetches with bounded concurrency
    const MAX_CONCURRENT_EXTRACTIONS = 5;
    
    // Pre-build work queue to avoid shared state mutations
    const extractionTasks: Array<{ item: IngestItem; fetchResult: any }> = [];
    for (const item of urlItems) {
      const fetchResult = results.get(item.url!);
      if (fetchResult) {
        extractionTasks.push({ item, fetchResult });
      }
    }
    
    // Process extractions with bounded concurrency
    let nextTaskIndex = 0;
    
    async function processExtractionTask(): Promise<void> {
      while (true) {
        // Get next task synchronously (safe in JS event loop)
        const taskIndex = nextTaskIndex++;
        if (taskIndex >= extractionTasks.length) break;
        
        const { item, fetchResult } = extractionTasks[taskIndex];
        
        // Extract text from fetched content
        const extraction = await extractContentAsync(fetchResult.body, fetchResult.contentType);
        
        if (extraction.strategy === "metadata-only" || !extraction.text) {
          // Unsupported content type - add to errors (synchronous push is safe)
          fetchErrors.push({
            url: item.url!,
            status: fetchResult.status,
            reason: `unsupported_content_type: ${fetchResult.contentType}`,
          });
          continue;
        }
        
        // Success: populate text and metadata
        item.text = extraction.text;
        if (!item.source) {
          item.source = toSourceFromUrl(fetchResult.resolvedUrl);
        }
        
        // Add fetch metadata to item metadata
        item.metadata = {
          ...(item.metadata || {}),
          fetchedUrl: fetchResult.url,
          resolvedUrl: fetchResult.resolvedUrl,
          contentType: fetchResult.contentType,
          fetchStatus: fetchResult.status,
          fetchedAt: fetchResult.fetchedAt,
          extractionStrategy: extraction.strategy,
        };
        
        if (extraction.title) {
          item.metadata.extractedTitle = extraction.title;
        }
        
        // Move to textItems for normal processing (synchronous push is safe)
        textItems.push(item);
        fetchedCount++;
      }
    }
    
    // Start bounded concurrent extraction workers
    const workers: Promise<void>[] = [];
    for (let i = 0; i < Math.min(MAX_CONCURRENT_EXTRACTIONS, extractionTasks.length); i++) {
      workers.push(processExtractionTask());
    }
    
    await Promise.all(workers);
  }
  
  // Pre-process items to assign stable baseIds and detect metadata
  interface ProcessedItem {
    baseId: string;
    docType: DocType;
    tier1Meta: Record<string, unknown>;
    chunks: string[];
    source: string;
    metadata?: Record<string, unknown>;
  }
  
  const processedItems: ProcessedItem[] = [];
  for (const item of textItems) {
    if (!item.text) {
      // Report missing text as error instead of silently dropping
      fetchErrors.push({
        url: item.url || item.source || "(unknown)",
        status: null,
        reason: "missing_text: item has no text content",
      });
      continue;
    }

    if (!item.source && item.url) {
      item.source = toSourceFromUrl(item.url);
    }

    if (!item.source) {
      // Report missing source as error instead of silently dropping
      fetchErrors.push({
        url: item.url || "(unknown)",
        status: null,
        reason: "missing_source: item has no source identifier",
      });
      continue;
    }

    const docType = detectDocType(item);
    const metadata: Record<string, unknown> = {
      ...(item.metadata ?? {}),
    };
    if (item.url) {
      metadata.itemUrl = item.url;
    }

    processedItems.push({
      baseId: item.id ?? randomUUID(),
      docType,
      tier1Meta: extractTier1(item, docType),
      chunks: chunkText(item.text),
      source: item.source,
      metadata,
    });
  }
  
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

    const result: IngestResult = {
      ok: true,
      upserted: totalUpserted,
      enrichment: {
        enqueued: tasks.length,
        docTypes: docTypeCounts,
      },
    };
    
    if (fetchedCount > 0) {
      result.fetched = fetchedCount;
    }
    
    if (fetchErrors.length > 0) {
      result.errors = fetchErrors;
    }
    
    return result;
  }

  const result: IngestResult = { 
    ok: true, 
    upserted: totalUpserted 
  };
  
  if (fetchedCount > 0) {
    result.fetched = fetchedCount;
  }
  
  if (fetchErrors.length > 0) {
    result.errors = fetchErrors;
  }
  
  return result;
}
