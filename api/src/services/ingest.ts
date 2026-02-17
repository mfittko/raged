import { createHash, randomUUID } from "node:crypto";
import { chunkText } from "../chunking.js";
import { detectDocType, type DocType, type IngestItem } from "../doctype.js";
import { extractTier1 } from "../extractors/index.js";
import type { EnrichmentTask } from "../types.js";
import { fetchUrls } from "./url-fetch.js";
import { extractContentAsync } from "./url-extract.js";
import { getPool } from "../db.js";
import { deriveIdentityKey, formatVector } from "../pg-helpers.js";
import { embed as embedTexts } from "../ollama.js";
import { shouldStoreRawBlob, uploadRawBlob } from "../blob-store.js";

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
  overwrite?: boolean;
  items: IngestItem[];
}

export interface IngestResult {
  ok: true;
  upserted: number;
  skipped?: number;
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

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toSourceFromUrl(rawUrl: string): string {
  try {
    const urlObj = new URL(rawUrl);
    return `${urlObj.origin}${urlObj.pathname}`;
  } catch {
    // Invalid URL format, return as-is
    return rawUrl;
  }
}

function computePayloadChecksum(payload: Buffer): string {
  return createHash("sha256").update(payload).digest("hex");
}

function normalizeMimeType(rawMimeType: string | undefined, source: string, metadata: Record<string, unknown>): string {
  if (typeof rawMimeType === "string" && rawMimeType.trim().length > 0) {
    return rawMimeType;
  }

  const metadataContentType = metadata.contentType;
  if (typeof metadataContentType === "string" && metadataContentType.trim().length > 0) {
    return metadataContentType;
  }

  const lowerSource = source.toLowerCase();
  if (lowerSource.endsWith(".pdf")) {
    return "application/pdf";
  }

  if (lowerSource.endsWith(".png")) {
    return "image/png";
  }

  if (lowerSource.endsWith(".jpg") || lowerSource.endsWith(".jpeg")) {
    return "image/jpeg";
  }

  if (lowerSource.endsWith(".gif")) {
    return "image/gif";
  }

  if (lowerSource.endsWith(".webp")) {
    return "image/webp";
  }

  if (lowerSource.endsWith(".md")) {
    return "text/markdown; charset=utf-8";
  }

  if (lowerSource.endsWith(".html") || lowerSource.endsWith(".htm")) {
    return "text/html; charset=utf-8";
  }

  return "text/plain; charset=utf-8";
}

function resolveRawPayload(item: IngestItem, source: string, text: string, metadata: Record<string, unknown>): { rawBytes: Buffer; rawMimeType: string } {
  let rawBytes: Buffer;

  if (typeof item.rawData === "string" && item.rawData.length > 0) {
    try {
      rawBytes = Buffer.from(item.rawData, "base64");
    } catch {
      rawBytes = Buffer.from(text, "utf8");
    }
  } else {
    rawBytes = Buffer.from(text, "utf8");
  }

  const rawMimeType = normalizeMimeType(item.rawMimeType, source, metadata);
  return { rawBytes, rawMimeType };
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
  const shouldOverwrite = request.overwrite === true;

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

        item.rawData = fetchResult.body.toString("base64");
        item.rawMimeType = fetchResult.contentType;
        
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
    identityKey: string;
    payloadChecksum: string;
    docType: DocType;
    tier1Meta: Record<string, unknown>;
    chunks: string[];
    source: string;
    repoId: string | null;
    repoUrl: string | null;
    path: string | null;
    lang: string | null;
    itemUrl?: string;
    metadata?: Record<string, unknown>;
    rawData: Buffer;
    rawMimeType: string;
    shouldStoreRaw: boolean;
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
    const tier1Meta = extractTier1(item, docType);
    const metadata: Record<string, unknown> = {
      ...(item.metadata ?? {}),
    };
    
    // Copy filter-relevant fields from metadata to tier1Meta
    // Use explicit undefined checks to preserve falsy but valid values (empty strings, 0, etc.)
    if (metadata.repoId !== undefined) tier1Meta.repoId = metadata.repoId;
    if (metadata.repoUrl !== undefined) tier1Meta.repoUrl = metadata.repoUrl;
    if (metadata.path !== undefined) tier1Meta.path = metadata.path;
    if (metadata.lang !== undefined) tier1Meta.lang = metadata.lang;

    const repoId = asNonEmptyString(metadata.repoId);
    const repoUrl = asNonEmptyString(metadata.repoUrl);
    const path = asNonEmptyString(metadata.path);
    const lang = asNonEmptyString(metadata.lang) ?? asNonEmptyString(tier1Meta.lang);

    const { rawBytes, rawMimeType } = resolveRawPayload(item, item.source, item.text, metadata);

    processedItems.push({
      baseId: item.id ?? randomUUID(),
      identityKey: deriveIdentityKey(item.source),
      payloadChecksum: computePayloadChecksum(rawBytes),
      docType,
      tier1Meta,
      chunks: chunkText(item.text),
      source: item.source,
      repoId,
      repoUrl,
      path,
      lang,
      itemUrl: item.url,
      metadata,
      rawData: rawBytes,
      rawMimeType,
      shouldStoreRaw: shouldStoreRawBlob(rawBytes.length),
    });
  }

  let totalUpserted = 0;
  let skippedCount = 0;
  const enrichmentTasks: EnrichmentTask[] = [];
  const docTypeCounts: Record<string, number> = {};

  // Upsert documents and chunks in transactions
  const pool = getPool();
  const client = await pool.connect();
  try {
    const existingChecksumsByIdentity = new Map<string, string | null>();
    if (!shouldOverwrite && processedItems.length > 0) {
      const uniqueIdentityKeys = Array.from(new Set(processedItems.map((item) => item.identityKey)));
      const existingRows = await client.query<{ identity_key: string; payload_checksum: string | null }>(
        `SELECT identity_key, payload_checksum
         FROM documents
         WHERE collection = $1 AND identity_key = ANY($2::text[])`,
        [col, uniqueIdentityKeys],
      );

      for (const row of existingRows.rows) {
        existingChecksumsByIdentity.set(row.identity_key, row.payload_checksum);
      }
    }

    for (const procItem of processedItems) {
      // Skip only if overwrite=false AND checksums match (idempotent skip for unchanged content)
      if (!shouldOverwrite && existingChecksumsByIdentity.has(procItem.identityKey)) {
        const existingChecksum = existingChecksumsByIdentity.get(procItem.identityKey);
        if (existingChecksum === procItem.payloadChecksum) {
          // Checksum matches - skip this document as content is unchanged
          skippedCount++;
          continue;
        }
        // Checksum differs - continue with upsert to update changed content
      }

      try {
        const chunkBatches: Array<{ batchStart: number; chunks: string[]; vectors: number[][] }> = [];
        for (let batchStart = 0; batchStart < procItem.chunks.length; batchStart += EMBED_BATCH_SIZE) {
          const batchEnd = Math.min(batchStart + EMBED_BATCH_SIZE, procItem.chunks.length);
          const batchChunks = procItem.chunks.slice(batchStart, batchEnd);
          const batchVectors = await embedTexts(batchChunks);
          chunkBatches.push({ batchStart, chunks: batchChunks, vectors: batchVectors });
        }

        await client.query("BEGIN");

        // Upsert document
        const docResult = await client.query<{ id: string; base_id: string }>(
          shouldOverwrite
            ? `INSERT INTO documents (
                base_id, identity_key, source, item_url, doc_type, collection, repo_id, repo_url, path, lang, metadata, payload_checksum, raw_key, raw_bytes, mime_type, ingested_at
              , raw_data
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
              ON CONFLICT (collection, identity_key) 
              DO UPDATE SET
                base_id = documents.base_id,
                item_url = EXCLUDED.item_url,
                doc_type = EXCLUDED.doc_type,
                repo_id = EXCLUDED.repo_id,
                repo_url = EXCLUDED.repo_url,
                path = EXCLUDED.path,
                lang = EXCLUDED.lang,
                metadata = EXCLUDED.metadata,
                payload_checksum = EXCLUDED.payload_checksum,
                raw_key = EXCLUDED.raw_key,
                raw_bytes = EXCLUDED.raw_bytes,
                mime_type = EXCLUDED.mime_type,
                raw_data = EXCLUDED.raw_data,
                last_seen = now()
              RETURNING id, base_id`
            : `INSERT INTO documents (
                base_id, identity_key, source, item_url, doc_type, collection, repo_id, repo_url, path, lang, metadata, payload_checksum, raw_key, raw_bytes, mime_type, ingested_at
              , raw_data
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
              ON CONFLICT (collection, identity_key)
              DO NOTHING
              RETURNING id, base_id`,
          [
            procItem.baseId,
            procItem.identityKey,
            procItem.source,
            procItem.itemUrl || null,
            procItem.docType,
            col,
            procItem.repoId,
            procItem.repoUrl,
            procItem.path,
            procItem.lang,
            JSON.stringify(procItem.metadata || {}),
            procItem.payloadChecksum,
            null,
            procItem.shouldStoreRaw ? null : procItem.rawData.length,
            procItem.shouldStoreRaw ? null : procItem.rawMimeType,
            now,
            procItem.shouldStoreRaw ? null : procItem.rawData,
          ]
        );

        if (docResult.rowCount === 0) {
          await client.query("COMMIT");
          skippedCount++;
          existingChecksumsByIdentity.set(procItem.identityKey, procItem.payloadChecksum);
          continue;
        }

        const documentId = docResult.rows[0].id;
        const persistedBaseId = docResult.rows[0].base_id;

        if (procItem.shouldStoreRaw) {
          const rawUpload = await uploadRawBlob({
            documentId,
            source: procItem.source,
            body: procItem.rawData,
            mimeType: procItem.rawMimeType,
          });

          await client.query(
            `UPDATE documents
             SET raw_key = $2, raw_bytes = $3, mime_type = $4, payload_checksum = $5
             WHERE id = $1`,
            [documentId, rawUpload.key, rawUpload.bytes, rawUpload.mimeType, procItem.payloadChecksum],
          );
        }

        // Upsert embedded chunks in batches
        for (const batch of chunkBatches) {
          const { batchStart, chunks: batchChunks, vectors: batchVectors } = batch;

          // Upsert chunks
          const chunkValues: unknown[] = [];
          const chunkRows: string[] = [];

          // 12 parameters per row for chunks INSERT query.
          const PARAMS_PER_CHUNK = 12;
          
          for (let i = 0; i < batchChunks.length; i++) {
            const chunkIndex = batchStart + i;
            const base = i * PARAMS_PER_CHUNK;
            chunkRows.push(
              `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}::vector, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11}, $${base + 12})`
            );
            chunkValues.push(
              documentId,
              chunkIndex,
              batchChunks[i],
              formatVector(batchVectors[i]),
              shouldEnrich ? "pending" : "none",
              JSON.stringify(procItem.tier1Meta),
              procItem.repoId,
              procItem.repoUrl,
              procItem.path,
              procItem.lang,
              procItem.docType,
              procItem.itemUrl || null,
            );
          }

          await client.query(
            `INSERT INTO chunks (
              document_id, chunk_index, text, embedding, enrichment_status, tier1_meta, repo_id, repo_url, path, lang, doc_type, item_url
            ) VALUES ${chunkRows.join(", ")}
            ON CONFLICT (document_id, chunk_index)
            DO UPDATE SET
              text = EXCLUDED.text,
              embedding = EXCLUDED.embedding,
              enrichment_status = EXCLUDED.enrichment_status,
              tier1_meta = EXCLUDED.tier1_meta,
              repo_id = EXCLUDED.repo_id,
              repo_url = EXCLUDED.repo_url,
              path = EXCLUDED.path,
              lang = EXCLUDED.lang,
              doc_type = EXCLUDED.doc_type,
              item_url = EXCLUDED.item_url`,
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
        existingChecksumsByIdentity.set(procItem.identityKey, procItem.payloadChecksum);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    client.release();
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
      skipped: skippedCount,
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
    upserted: totalUpserted,
    skipped: skippedCount,
  };
  
  if (fetchedCount > 0) {
    result.fetched = fetchedCount;
  }
  
  if (fetchErrors.length > 0) {
    result.errors = fetchErrors;
  }
  
  return result;
}
