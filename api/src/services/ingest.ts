import { randomUUID } from "node:crypto";
import { chunkText } from "../chunking.js";
import { detectDocType, type DocType, type IngestItem } from "../doctype.js";
import { extractTier1 } from "../extractors/index.js";
import type { EnrichmentTask } from "../types.js";
import { fetchUrls } from "./url-fetch.js";
import { extractContentAsync } from "./url-extract.js";
import { getPool } from "../db.js";
import { deriveIdentityKey, formatVector } from "../pg-helpers.js";
import { embed as embedTexts } from "../ollama.js";

// Enrichment functions using Postgres task_queue
function isEnrichmentEnabled(): boolean {
  return process.env.ENRICHMENT_ENABLED === "true";
}

async function enqueueEnrichmentBatch(tasks: EnrichmentTask[], client: any): Promise<void> {
  if (!isEnrichmentEnabled() || tasks.length === 0) {
    return;
  }

  const now = new Date();
  const values: unknown[] = [];
  const rowsSql: string[] = [];

  for (let index = 0; index < tasks.length; index++) {
    const task = tasks[index];
    const base = index * 4;
    rowsSql.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`);
    values.push("enrichment", "pending", JSON.stringify(task), now);
  }

  await client.query(
    `INSERT INTO task_queue (queue, status, payload, run_after)
     VALUES ${rowsSql.join(", ")}`,
    values
  );
}

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

function toSourceFromUrl(rawUrl: string): string {
  try {
    const urlObj = new URL(rawUrl);
    return `${urlObj.origin}${urlObj.pathname}`;
  } catch {
    // Invalid URL format, return as-is
    return rawUrl;
  }
}

/**
 * Ingest documents and chunks into Postgres
 * All writes happen in a transaction for consistency
 */
export async function ingest(
  request: IngestRequest,
  collection?: string,
): Promise<IngestResult> {
  const col = collection || "docs";

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
    itemUrl?: string;
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

    processedItems.push({
      baseId: item.id ?? randomUUID(),
      docType,
      tier1Meta: extractTier1(item, docType),
      chunks: chunkText(item.text),
      source: item.source,
      itemUrl: item.url,
      metadata,
    });
  }
  
  let totalUpserted = 0;
  const enrichmentTasks: EnrichmentTask[] = [];
  const docTypeCounts: Record<string, number> = {};

  // Upsert documents and chunks in transactions
  const pool = getPool();
  
  for (const procItem of processedItems) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const identityKey = deriveIdentityKey(procItem.source);
      
      // Upsert document
      const docResult = await client.query<{ id: string; base_id: string }>(
        `INSERT INTO documents (
          base_id, identity_key, source, item_url, doc_type, collection, metadata, ingested_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (collection, identity_key) 
        DO UPDATE SET
          base_id = documents.base_id,
          item_url = EXCLUDED.item_url,
          doc_type = EXCLUDED.doc_type,
          metadata = EXCLUDED.metadata,
          last_seen = now()
        RETURNING id, base_id`,
        [
          procItem.baseId,
          identityKey,
          procItem.source,
          procItem.itemUrl || null,
          procItem.docType,
          col,
          JSON.stringify(procItem.metadata || {}),
          now,
        ]
      );

      const documentId = docResult.rows[0].id;
      const persistedBaseId = docResult.rows[0].base_id;

      // Embed chunks in batches
      for (let batchStart = 0; batchStart < procItem.chunks.length; batchStart += EMBED_BATCH_SIZE) {
        const batchEnd = Math.min(batchStart + EMBED_BATCH_SIZE, procItem.chunks.length);
        const batchChunks = procItem.chunks.slice(batchStart, batchEnd);
        const batchVectors = await embedTexts(batchChunks);

        // Upsert chunks
        const chunkValues: unknown[] = [];
        const chunkRows: string[] = [];
        
        // 6 parameters per row for the chunks INSERT query: document_id, chunk_index, text, embedding, enrichment_status, tier1_meta
        const PARAMS_PER_CHUNK = 6;
        
        for (let i = 0; i < batchChunks.length; i++) {
          const chunkIndex = batchStart + i;
          const base = i * PARAMS_PER_CHUNK;
          chunkRows.push(
            `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`
          );
          chunkValues.push(
            documentId,
            chunkIndex,
            batchChunks[i],
            formatVector(batchVectors[i]),
            shouldEnrich ? "pending" : "none",
            JSON.stringify(procItem.tier1Meta)
          );
        }

        await client.query(
          `INSERT INTO chunks (
            document_id, chunk_index, text, embedding, enrichment_status, tier1_meta
          ) VALUES ${chunkRows.join(", ")}
          ON CONFLICT (document_id, chunk_index)
          DO UPDATE SET
            text = EXCLUDED.text,
            embedding = EXCLUDED.embedding,
            enrichment_status = EXCLUDED.enrichment_status,
            tier1_meta = EXCLUDED.tier1_meta`,
          chunkValues
        );

        totalUpserted += batchChunks.length;
      }

      // Build enrichment tasks if enabled
      if (shouldEnrich) {
        docTypeCounts[procItem.docType] = (docTypeCounts[procItem.docType] || 0) + procItem.chunks.length;

        for (let chunkIndex = 0; chunkIndex < procItem.chunks.length; chunkIndex++) {
          enrichmentTasks.push({
            taskId: randomUUID(),
            chunkId: `${persistedBaseId}:${chunkIndex}`,
            collection: col,
            docType: procItem.docType,
            baseId: persistedBaseId,
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

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  // Enqueue enrichment tasks in batches
  if (shouldEnrich && enrichmentTasks.length > 0) {
    const TASK_BATCH_SIZE = 100;
    const client = await pool.connect();
    try {
      for (let i = 0; i < enrichmentTasks.length; i += TASK_BATCH_SIZE) {
        const batch = enrichmentTasks.slice(i, i + TASK_BATCH_SIZE);
        await enqueueEnrichmentBatch(batch, client);
      }
    } catch (error) {
      // Re-throw the error after ensuring proper cleanup in finally
      throw error;
    } finally {
      client.release();
    }

    const result: IngestResult = {
      ok: true,
      upserted: totalUpserted,
      enrichment: {
        enqueued: enrichmentTasks.length,
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
