import { randomUUID } from "node:crypto";
import type { EnrichmentTask } from "../types.js";
import { getPool } from "../db.js";

export interface EnrichmentStatusRequest {
  baseId: string;
  collection?: string;
}

export interface EnrichmentStatusResult {
  baseId: string;
  status: "enriched" | "processing" | "pending" | "failed" | "none" | "mixed";
  chunks: {
    total: number;
    enriched: number;
    pending: number;
    processing: number;
    failed: number;
    none: number;
  };
  extractedAt?: string;
  metadata?: {
    tier2?: Record<string, unknown>;
    tier3?: Record<string, unknown>;
    error?: {
      message: string;
      taskId?: string;
      attempt?: number;
      maxAttempts?: number;
      final?: boolean;
      failedAt?: string;
      chunkIndex?: number;
    };
  };
}

export interface EnrichmentStatsResult {
  queue: {
    pending: number;
    processing: number;
    deadLetter: number;
  };
  totals: {
    enriched: number;
    failed: number;
    pending: number;
    processing: number;
    none: number;
  };
}

export interface EnrichmentStatsRequest {
  collection?: string;
  filter?: string;
}

export interface EnqueueRequest {
  collection?: string;
  force?: boolean;
  filter?: string;
}

export interface EnqueueResult {
  ok: true;
  enqueued: number;
}

export interface ClearRequest {
  collection?: string;
  filter?: string;
}

export interface ClearResult {
  ok: true;
  cleared: number;
}

export async function getEnrichmentStatus(
  request: EnrichmentStatusRequest,
  collection?: string,
): Promise<EnrichmentStatusResult> {
  const col = collection || "docs";
  const pool = getPool();

  const result = await pool.query<{
    chunk_index: number;
    enrichment_status: string;
    enriched_at: string | null;
    tier2_meta: Record<string, unknown> | null;
    tier3_meta: Record<string, unknown> | null;
  }>(
    `SELECT 
      c.chunk_index,
      c.enrichment_status,
      c.enriched_at,
      c.tier2_meta,
      c.tier3_meta
    FROM chunks c
    JOIN documents d ON c.document_id = d.id
    WHERE d.base_id = $1 AND d.collection = $2
    ORDER BY c.chunk_index`,
    [request.baseId, col]
  );

  if (result.rows.length === 0) {
    const error = new Error(`No chunks found for baseId: ${request.baseId}`) as Error & { statusCode?: number };
    error.statusCode = 404;
    throw error;
  }

  const statusCounts = {
    enriched: 0,
    pending: 0,
    processing: 0,
    failed: 0,
    none: 0,
  };

  let latestExtractedAt: string | undefined;
  let tier2Meta: Record<string, unknown> | undefined;
  let tier3Meta: Record<string, unknown> | undefined;
  let errorMeta: NonNullable<EnrichmentStatusResult["metadata"]>["error"] | undefined;

  for (const chunk of result.rows) {
    const status = chunk.enrichment_status || "none";
    if (status in statusCounts) {
      statusCounts[status as keyof typeof statusCounts]++;
    }

    if (status === "enriched") {
      const extractedAt = chunk.enriched_at;
      if (extractedAt && (!latestExtractedAt || extractedAt > latestExtractedAt)) {
        latestExtractedAt = extractedAt;
      }

      if (chunk.tier2_meta) {
        tier2Meta = chunk.tier2_meta;
      }
      if (chunk.tier3_meta) {
        tier3Meta = chunk.tier3_meta;
      }
    }

    const maybeError = chunk.tier3_meta?._error;
    if (maybeError && typeof maybeError === "object" && "message" in maybeError) {
      const errorObj = maybeError as Record<string, unknown>;
      if (typeof errorObj.message === "string" && errorObj.message.length > 0) {
        errorMeta = {
          message: errorObj.message,
          taskId: typeof errorObj.taskId === "string" ? errorObj.taskId : undefined,
          attempt: typeof errorObj.attempt === "number" ? errorObj.attempt : undefined,
          maxAttempts:
            typeof errorObj.maxAttempts === "number" ? errorObj.maxAttempts : undefined,
          final: typeof errorObj.final === "boolean" ? errorObj.final : undefined,
          failedAt: typeof errorObj.failedAt === "string" ? errorObj.failedAt : undefined,
          chunkIndex: chunk.chunk_index,
        };
      }
    }
  }

  // Determine overall status
  let status: "enriched" | "processing" | "pending" | "failed" | "none" | "mixed";
  const total = result.rows.length;
  if (statusCounts.enriched === total) {
    status = "enriched";
  } else if (statusCounts.pending === total) {
    status = "pending";
  } else if (statusCounts.processing === total) {
    status = "processing";
  } else if (statusCounts.none === total) {
    status = "none";
  } else if (statusCounts.failed > 0) {
    status = "failed";
  } else {
    status = "mixed";
  }

  const statusResult: EnrichmentStatusResult = {
    baseId: request.baseId,
    status,
    chunks: {
      total,
      ...statusCounts,
    },
  };

  if (latestExtractedAt) {
    statusResult.extractedAt = latestExtractedAt;
  }

  if (tier2Meta || tier3Meta || errorMeta) {
    statusResult.metadata = {};
    if (tier2Meta) statusResult.metadata.tier2 = tier2Meta;
    if (tier3Meta) statusResult.metadata.tier3 = tier3Meta;
    if (errorMeta) statusResult.metadata.error = errorMeta;
  }

  return statusResult;
}

export async function getEnrichmentStats(request: EnrichmentStatsRequest = {}): Promise<EnrichmentStatsResult> {
  const pool = getPool();
  const collection = (request.collection || "").trim();
  const filterText = (request.filter || "").trim();
  const hasCollection = collection.length > 0;
  const hasFilter = filterText.length > 0;
  const likeFilter = `%${filterText}%`;

  const queueParams: unknown[] = [];
  let queueWhere = "WHERE t.queue = 'enrichment'";

  if (hasCollection) {
    const collectionIndex = queueParams.length + 1;
    queueWhere += ` AND COALESCE(t.payload->>'collection', '') = $${collectionIndex}`;
    queueParams.push(collection);
  }

  if (hasFilter) {
    const queryIndex = queueParams.length + 1;
    const likeIndex = queueParams.length + 2;
    queueWhere += `
      AND (
        to_tsvector(
          'simple',
          concat_ws(
            ' ',
            COALESCE(t.payload->>'text', ''),
            COALESCE(t.payload->>'source', ''),
            COALESCE(t.payload->>'baseId', ''),
            COALESCE(t.payload->>'docType', '')
          )
        ) @@ websearch_to_tsquery('simple', $${queryIndex})
        OR COALESCE(t.payload->>'text', '') ILIKE $${likeIndex}
        OR COALESCE(t.payload->>'source', '') ILIKE $${likeIndex}
        OR COALESCE(t.payload->>'baseId', '') ILIKE $${likeIndex}
        OR COALESCE(t.payload->>'docType', '') ILIKE $${likeIndex}
      )`;
    queueParams.push(filterText, likeFilter);
  }

  // Get queue stats from task_queue
  const queueResult = await pool.query<{ status: string; count: number }>(
    `SELECT status, COUNT(*)::int AS count
    FROM task_queue t
    ${queueWhere}
    GROUP BY status`,
    queueParams,
  );

  const queueCounts = {
    pending: 0,
    processing: 0,
    deadLetter: 0,
  };

  for (const row of queueResult.rows) {
    if (row.status === "pending") {
      queueCounts.pending = row.count;
    } else if (row.status === "processing") {
      queueCounts.processing = row.count;
    } else if (row.status === "dead") {
      queueCounts.deadLetter = row.count;
    }
  }

  const chunksParams: unknown[] = [];
  let chunksWhere = "";

  if (hasCollection) {
    const collectionIndex = chunksParams.length + 1;
    chunksWhere = `WHERE d.collection = $${collectionIndex}`;
    chunksParams.push(collection);
  }

  if (hasFilter) {
    const queryIndex = chunksParams.length + 1;
    const likeIndex = chunksParams.length + 2;
    const joiner = chunksWhere ? "AND" : "WHERE";
    chunksWhere += `
      ${joiner} (
        to_tsvector(
          'simple',
          concat_ws(
            ' ',
            c.text,
            d.source,
            c.doc_type,
            COALESCE(d.summary, ''),
            COALESCE(d.summary_short, ''),
            COALESCE(d.summary_medium, ''),
            COALESCE(d.summary_long, '')
          )
        ) @@ websearch_to_tsquery('simple', $${queryIndex})
        OR c.text ILIKE $${likeIndex}
        OR d.source ILIKE $${likeIndex}
        OR c.doc_type ILIKE $${likeIndex}
        OR COALESCE(d.summary, '') ILIKE $${likeIndex}
        OR COALESCE(d.summary_short, '') ILIKE $${likeIndex}
        OR COALESCE(d.summary_medium, '') ILIKE $${likeIndex}
        OR COALESCE(d.summary_long, '') ILIKE $${likeIndex}
      )`;
    chunksParams.push(filterText, likeFilter);
  }

  // Get totals from chunks table
  const chunksResult = await pool.query<{ enrichment_status: string; count: number }>(
    `SELECT COALESCE(c.enrichment_status, 'none') AS enrichment_status, COUNT(*)::int AS count
    FROM chunks c
    JOIN documents d ON c.document_id = d.id
    ${chunksWhere}
    GROUP BY COALESCE(c.enrichment_status, 'none')`,
    chunksParams,
  );

  const totals = {
    enriched: 0,
    failed: 0,
    pending: 0,
    processing: 0,
    none: 0,
  };

  for (const row of chunksResult.rows) {
    const status = row.enrichment_status;
    if (status in totals) {
      totals[status as keyof typeof totals] = row.count;
    }
  }

  return {
    queue: queueCounts,
    totals,
  };
}

export async function enqueueEnrichment(
  request: EnqueueRequest,
  collection?: string,
): Promise<EnqueueResult> {
  const col = collection || "docs";
  const pool = getPool();
  const filterText = (request.filter || "").trim();
  const hasFilter = filterText.length > 0;
  const likeFilter = `%${filterText}%`;

  // Build filter for chunks that need enrichment
  let filterSql = "";
  if (!request.force) {
    filterSql = " AND c.enrichment_status != 'enriched'";
  }

  interface ChunkRow {
    chunk_id: string;
    document_id: string;
    base_id: string;
    chunk_index: number;
    text: string;
    source: string;
    doc_type: string;
    tier1_meta: Record<string, unknown> | null;
  }

  const PAGE_SIZE = 1000;
  const TASK_BATCH_SIZE = 100;
  let enqueued = 0;
  let lastDocumentId: string | null = null;
  let lastChunkIndex = -1;

  const client = await pool.connect();
  try {
    while (true) {
      const queryParams: unknown[] = [col];

      let fullTextFilterClause = "";
      if (hasFilter) {
        const textQueryIndex = queryParams.length + 1;
        const likeIndex = queryParams.length + 2;
        fullTextFilterClause = `
          AND (
            to_tsvector(
              'simple',
              concat_ws(
                ' ',
                c.text,
                d.source,
                c.doc_type,
                COALESCE(d.summary, ''),
                COALESCE(d.summary_short, ''),
                COALESCE(d.summary_medium, ''),
                COALESCE(d.summary_long, '')
              )
            ) @@ websearch_to_tsquery('simple', $${textQueryIndex})
            OR c.text ILIKE $${likeIndex}
            OR d.source ILIKE $${likeIndex}
            OR c.doc_type ILIKE $${likeIndex}
            OR COALESCE(d.summary, '') ILIKE $${likeIndex}
            OR COALESCE(d.summary_short, '') ILIKE $${likeIndex}
            OR COALESCE(d.summary_medium, '') ILIKE $${likeIndex}
            OR COALESCE(d.summary_long, '') ILIKE $${likeIndex}
          )`;
        queryParams.push(filterText, likeFilter);
      }

      let cursorClause = "";
      if (lastDocumentId) {
        const documentIndex = queryParams.length + 1;
        const chunkIndex = queryParams.length + 2;
        cursorClause = ` AND (d.id > $${documentIndex}::uuid OR (d.id = $${documentIndex}::uuid AND c.chunk_index > $${chunkIndex}))`;
        queryParams.push(lastDocumentId, lastChunkIndex);
        }

      const limitParam = queryParams.length + 1;
      queryParams.push(PAGE_SIZE);

      const chunkPage: { rows: ChunkRow[] } = await client.query<ChunkRow>(
        `SELECT
          c.id::text || ':' || c.chunk_index AS chunk_id,
          d.id AS document_id,
          d.base_id,
          c.chunk_index,
          c.text,
          d.source,
          c.doc_type,
          c.tier1_meta
        FROM chunks c
        JOIN documents d ON c.document_id = d.id
        WHERE d.collection = $1${filterSql}${fullTextFilterClause}${cursorClause}
        ORDER BY d.id, c.chunk_index
        LIMIT $${limitParam}`,
        queryParams
      );

      if (chunkPage.rows.length === 0) {
        break;
      }

      const documentIds = Array.from(new Set(chunkPage.rows.map((row) => row.document_id)));
      const countsResult = await client.query<{ document_id: string; total_chunks: number }>(
        `SELECT c.document_id, COUNT(*)::int AS total_chunks
         FROM chunks c
         JOIN documents d ON c.document_id = d.id
         WHERE d.collection = $1
           AND c.document_id = ANY($2::uuid[])
         GROUP BY c.document_id`,
        [col, documentIds]
      );
      const totalChunksByDocument = new Map(
        countsResult.rows.map((row) => [row.document_id, row.total_chunks])
      );

      const now = new Date().toISOString();
      for (let i = 0; i < chunkPage.rows.length; i += TASK_BATCH_SIZE) {
        const batchRows = chunkPage.rows.slice(i, i + TASK_BATCH_SIZE);
        const tasks: EnrichmentTask[] = [];

        for (const chunk of batchRows) {
          tasks.push({
            taskId: randomUUID(),
            chunkId: chunk.chunk_id,
            collection: col,
            docType: chunk.doc_type || "text",
            baseId: chunk.base_id,
            chunkIndex: chunk.chunk_index,
            totalChunks: totalChunksByDocument.get(chunk.document_id) ?? 1,
            text: chunk.text,
            source: chunk.source,
            tier1Meta: chunk.tier1_meta || {},
            attempt: 1,
            enqueuedAt: now,
          });
        }

        const values: unknown[] = [];
        const rowsSql: string[] = [];

        for (let j = 0; j < tasks.length; j++) {
          const task = tasks[j];
          const base = j * 4;
          rowsSql.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`);
          values.push("enrichment", "pending", JSON.stringify(task), now);
        }

        await client.query(
          `INSERT INTO task_queue (queue, status, payload, run_after)
           VALUES ${rowsSql.join(", ")}`,
          values
        );

        enqueued += tasks.length;
      }

      const lastRow: ChunkRow = chunkPage.rows[chunkPage.rows.length - 1];
      lastDocumentId = lastRow.document_id;
      lastChunkIndex = lastRow.chunk_index;
    }
  } catch (error) {
    // Re-throw the error after ensuring proper cleanup in finally
    throw error;
  } finally {
    client.release();
  }

  return { ok: true, enqueued };
}

export async function clearEnrichmentQueue(
  request: ClearRequest,
  collection?: string,
): Promise<ClearResult> {
  const col = collection || "docs";
  const pool = getPool();
  const filterText = (request.filter || "").trim();
  const hasFilter = filterText.length > 0;
  const likeFilter = `%${filterText}%`;

  const params: unknown[] = [col];
  let filterClause = "";

  if (hasFilter) {
    const queryIndex = params.length + 1;
    const likeIndex = params.length + 2;
    filterClause = `
      AND (
        to_tsvector(
          'simple',
          concat_ws(
            ' ',
            COALESCE(t.payload->>'text', ''),
            COALESCE(t.payload->>'source', ''),
            COALESCE(t.payload->>'baseId', ''),
            COALESCE(t.payload->>'docType', '')
          )
        ) @@ websearch_to_tsquery('simple', $${queryIndex})
        OR COALESCE(t.payload->>'text', '') ILIKE $${likeIndex}
        OR COALESCE(t.payload->>'source', '') ILIKE $${likeIndex}
        OR COALESCE(t.payload->>'baseId', '') ILIKE $${likeIndex}
        OR COALESCE(t.payload->>'docType', '') ILIKE $${likeIndex}
      )`;
    params.push(filterText, likeFilter);
  }

  const result = await pool.query<{ id: string }>(
    `DELETE FROM task_queue t
     WHERE t.queue = 'enrichment'
       AND t.status IN ('pending', 'processing', 'dead')
       AND COALESCE(t.payload->>'collection', '') = $1${filterClause}
     RETURNING t.id`,
    params,
  );

  return { ok: true, cleared: result.rowCount || 0 };
}
