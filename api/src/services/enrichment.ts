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

export interface EnrichmentStatsRequest {
  collection?: string;
  filter?: string;
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

export interface EnqueueRequest {
  collection?: string;
  force?: boolean;
  filter?: string;
}

export interface ClearRequest {
  collection?: string;
  filter?: string;
}

export interface ClearResult {
  ok: true;
  cleared: number;
}

export interface EnqueueResult {
  ok: true;
  enqueued: number;
}

export async function getEnrichmentStatus(
  request: EnrichmentStatusRequest,
  collection?: string,
): Promise<EnrichmentStatusResult> {
  const col = collection || "docs";
  const pool = getPool();

  const result = await pool.query<{
    enrichment_status: string;
    enriched_at: string | null;
    tier2_meta: Record<string, unknown> | null;
    tier3_meta: Record<string, unknown> | null;
  }>(
    `SELECT 
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
  let errorMeta: {
    message: string;
    taskId?: string;
    attempt?: number;
    maxAttempts?: number;
    final?: boolean;
    failedAt?: string;
    chunkIndex?: number;
  } | undefined;

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

    // Extract error metadata from tier3_meta._error
    if (status === "failed" && chunk.tier3_meta && typeof chunk.tier3_meta === "object") {
      const error = (chunk.tier3_meta as any)._error;
      if (error && typeof error === "object") {
        errorMeta = {
          message: error.message || "Unknown error",
          taskId: error.taskId,
          attempt: error.attempt,
          maxAttempts: error.maxAttempts,
          final: error.final,
          failedAt: error.failedAt,
          chunkIndex: error.chunkIndex,
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

export async function getEnrichmentStats(request?: EnrichmentStatsRequest): Promise<EnrichmentStatsResult> {
  const pool = getPool();
  const col = request?.collection || "docs";
  const filter = request?.filter;

  // Build filter clause for dual-mode search
  let queueFilterClause = "";
  let chunksFilterClause = "";
  const queueParams: unknown[] = [];
  const chunksParams: unknown[] = [];

  if (filter) {
    const queueFilterPattern = `%${filter}%`;
    queueFilterClause = ` AND (
      to_tsvector('simple', concat_ws(' ',
        t.payload->>'text',
        t.payload->>'source',
        t.payload->>'baseId',
        t.payload->>'docType'
      )) @@ websearch_to_tsquery('simple', $1)
      OR t.payload->>'text' ILIKE $2
      OR t.payload->>'source' ILIKE $2
      OR t.payload->>'baseId' ILIKE $2
      OR t.payload->>'docType' ILIKE $2
    )`;
    queueParams.push(filter, queueFilterPattern);

    const chunksFilterPattern = `%${filter}%`;
    chunksFilterClause = ` WHERE (
      to_tsvector('simple', concat_ws(' ',
        c.text,
        d.source,
        c.doc_type,
        d.summary,
        d.summary_short,
        d.summary_medium,
        d.summary_long
      )) @@ websearch_to_tsquery('simple', $1)
      OR c.text ILIKE $2
      OR d.source ILIKE $2
      OR c.doc_type ILIKE $2
      OR d.summary ILIKE $2
      OR d.summary_short ILIKE $2
      OR d.summary_medium ILIKE $2
      OR d.summary_long ILIKE $2
    )`;
    chunksParams.push(filter, chunksFilterPattern);
  }

  // Get queue stats from task_queue
  const queueResult = await pool.query<{ status: string; count: number }>(
    `SELECT status, COUNT(*)::int AS count
    FROM task_queue t
    WHERE t.queue = 'enrichment'
      AND COALESCE(t.payload->>'collection', 'docs') = $${queueParams.length + 1}${queueFilterClause}
    GROUP BY status`,
    [...queueParams, col]
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

  // Get totals from chunks table
  const chunksResult = await pool.query<{ enrichment_status: string; count: number }>(
    `SELECT c.enrichment_status, COUNT(*)::int AS count
    FROM chunks c
    JOIN documents d ON c.document_id = d.id${chunksFilterClause}
      ${filter ? "AND" : "WHERE"} d.collection = $${chunksParams.length + 1}
    GROUP BY c.enrichment_status`,
    [...chunksParams, col]
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

  // Build filter for chunks that need enrichment
  let filterSql = "";
  if (!request.force) {
    filterSql = " AND c.enrichment_status != 'enriched'";
  }

  // Add text filter if provided
  let textFilterClause = "";
  const baseParams: unknown[] = [col];
  if (request.filter) {
    const filterPattern = `%${request.filter}%`;
    textFilterClause = ` AND (
      to_tsvector('simple', concat_ws(' ',
        c.text,
        d.source,
        c.doc_type,
        d.summary,
        d.summary_short,
        d.summary_medium,
        d.summary_long
      )) @@ websearch_to_tsquery('simple', $${baseParams.length + 1})
      OR c.text ILIKE $${baseParams.length + 2}
      OR d.source ILIKE $${baseParams.length + 2}
      OR c.doc_type ILIKE $${baseParams.length + 2}
      OR d.summary ILIKE $${baseParams.length + 2}
      OR d.summary_short ILIKE $${baseParams.length + 2}
      OR d.summary_medium ILIKE $${baseParams.length + 2}
      OR d.summary_long ILIKE $${baseParams.length + 2}
    )`;
    baseParams.push(request.filter, filterPattern);
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
      const cursorClause: string = lastDocumentId
        ? ` AND (d.id > $${baseParams.length + 1}::uuid OR (d.id = $${baseParams.length + 1}::uuid AND c.chunk_index > $${baseParams.length + 2}))`
        : "";

      const queryParams: unknown[] = [...baseParams];
      if (lastDocumentId) {
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
        WHERE d.collection = $1${filterSql}${textFilterClause}${cursorClause}
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
  const col = collection || request.collection || "docs";
  const pool = getPool();

  // Build filter clause if provided
  let filterClause = "";
  const params: unknown[] = [col];
  if (request.filter) {
    const filterPattern = `%${request.filter}%`;
    filterClause = ` AND (
      to_tsvector('simple', concat_ws(' ',
        t.payload->>'text',
        t.payload->>'source',
        t.payload->>'baseId',
        t.payload->>'docType'
      )) @@ websearch_to_tsquery('simple', $${params.length + 1})
      OR t.payload->>'text' ILIKE $${params.length + 2}
      OR t.payload->>'source' ILIKE $${params.length + 2}
      OR t.payload->>'baseId' ILIKE $${params.length + 2}
      OR t.payload->>'docType' ILIKE $${params.length + 2}
    )`;
    params.push(request.filter, filterPattern);
  }

  const result = await pool.query(
    `DELETE FROM task_queue t
    WHERE t.queue = 'enrichment'
      AND t.status IN ('pending', 'processing', 'dead')
      AND COALESCE(t.payload->>'collection', 'docs') = $1${filterClause}
    RETURNING t.id`,
    params
  );

  return { ok: true, cleared: result.rowCount || 0 };
}
