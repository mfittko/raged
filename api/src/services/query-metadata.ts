import { getPool } from "../db.js";
import { translateFilter } from "../pg-helpers.js";
import type { QueryResultItem, BaseQueryResult } from "./query.js";
import type { FilterDSL } from "../pg-helpers.js";

export interface MetadataQueryRequest {
  collection?: string;
  topK?: number;
  filter?: Record<string, unknown> | FilterDSL;
}

/**
 * Metadata-only query path (strategy: "metadata").
 *
 * Skips embedding entirely — no embed() call is made.
 * All results are returned with score=1.0 (binary pass/fail).
 * Results are ordered by c.created_at DESC (most recent first).
 * topK is honored via SQL LIMIT.
 *
 * NOTE: Empty-query support (query field absent) requires schema relaxation
 * from mfittko/RAGed#112 before it is active via the router.
 */
export async function queryMetadata(
  request: MetadataQueryRequest,
  collection?: string,
): Promise<BaseQueryResult> {
  const col = collection ?? request.collection ?? "docs";
  const topK = request.topK ?? 8;

  // Translate filter — offset by 2 for $1=collection, $2=topK
  const { sql: filterSql, params: filterParams } = translateFilter(
    request.filter,
    2,
  );

  const pool = getPool();
  const result = await pool.query<{
    chunk_id: string;
    text: string;
    source: string;
    chunk_index: number;
    base_id: string;
    doc_type: string;
    repo_id: string | null;
    repo_url: string | null;
    path: string | null;
    lang: string | null;
    item_url: string | null;
    tier1_meta: Record<string, unknown> | null;
    tier2_meta: Record<string, unknown> | null;
    tier3_meta: Record<string, unknown> | null;
    doc_summary: string | null;
    doc_summary_short: string | null;
    doc_summary_medium: string | null;
    doc_summary_long: string | null;
    payload_checksum: string | null;
  }>(
    `SELECT
      c.id::text || ':' || c.chunk_index::text AS chunk_id,
      c.text,
      d.source,
      c.chunk_index,
      d.base_id,
      c.doc_type,
      c.repo_id,
      c.repo_url,
      c.path,
      c.lang,
      c.item_url,
      c.tier1_meta,
      c.tier2_meta,
      c.tier3_meta,
      d.summary AS doc_summary,
      d.summary_short AS doc_summary_short,
      d.summary_medium AS doc_summary_medium,
      d.summary_long AS doc_summary_long,
      d.payload_checksum
    FROM chunks c
    JOIN documents d ON c.document_id = d.id
    WHERE d.collection = $1${filterSql}
    ORDER BY c.created_at DESC
    LIMIT $2`,
    [col, topK, ...filterParams],
  );

  const results: QueryResultItem[] = result.rows.map((row) => ({
    id: row.chunk_id,
    score: 1.0,
    source: row.source,
    text: row.text,
    payload: {
      chunkIndex: row.chunk_index,
      baseId: row.base_id,
      docType: row.doc_type,
      repoId: row.repo_id,
      repoUrl: row.repo_url,
      path: row.path,
      lang: row.lang,
      itemUrl: row.item_url,
      tier1Meta: row.tier1_meta,
      tier2Meta: row.tier2_meta,
      tier3Meta: row.tier3_meta,
      docSummary: row.doc_summary,
      docSummaryShort: row.doc_summary_short,
      docSummaryMedium: row.doc_summary_medium,
      docSummaryLong: row.doc_summary_long,
      payloadChecksum: row.payload_checksum,
    },
  }));

  return { ok: true, results };
}
