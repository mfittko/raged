import { getPool } from "../db.js";
import { translateFilter } from "../pg-helpers.js";
import { embed as embedTexts } from "../embeddings.js";
import type { GraphParams } from "./graph-strategy.js";
import { executeGraphStrategy } from "./graph-strategy.js";
import { SqlGraphBackend } from "./sql-graph-backend.js";

export type { GraphParams };

export interface QueryRequest {
  collection?: string;
  query: string;
  topK?: number;
  minScore?: number;
  filter?: Record<string, unknown>;
  /** @deprecated Use `graph` instead. */
  graphExpand?: boolean;
  graph?: GraphParams;
}

export function countQueryTerms(value: string): number {
  return value.trim().split(/\s+/).filter((t) => t.length > 0).length;
}

export function getAutoMinScore(queryText: string): number {
  const terms = countQueryTerms(queryText);
  if (terms <= 1) return 0.3;
  if (terms === 2) return 0.4;
  if (terms <= 4) return 0.5;
  return 0.6;
}

export interface QueryResultItem {
  id: string | number;
  score: number;
  source?: string;
  text?: string;
  payload?: Record<string, unknown>;
}

export type { GraphResult as GraphData } from "./graph-backend.js";
import type { GraphResult } from "./graph-backend.js";

export interface QueryResult {
  ok: true;
  results: QueryResultItem[];
  graph?: GraphResult;
}

/**
 * Query documents using pgvector similarity search
 */
export async function query(
  request: QueryRequest,
  collection?: string,
): Promise<QueryResult> {
  const col = collection || "docs";

  const vectors = await embedTexts([request.query]);
  const [vector] = vectors;
  if (!vector) {
    throw new Error("Embedding failed: no vector returned");
  }
  const topK = request.topK ?? 8;
  const minScore = request.minScore ?? getAutoMinScore(request.query);
  const maxDistance = 1 - minScore;

  // Translate filter to Postgres WHERE clause (offset by 4 for base params: $1=collection, $2=vector, $3=topK, $4=maxDistance)
  const { sql: filterSql, params: filterParams } = translateFilter(request.filter, 4);

  // Build query with pgvector cosine distance
  const pool = getPool();
  
  // Use parameterized query for the vector to prevent SQL injection
  const result = await pool.query<{
    chunk_id: string;
    distance: number;
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
      c.embedding <=> $2::vector AS distance,
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
    WHERE d.collection = $1
      AND c.embedding IS NOT NULL
      AND (c.embedding <=> $2::vector) <= $4${filterSql}
    ORDER BY c.embedding <=> $2::vector
    LIMIT $3`,
    [col, JSON.stringify(vector), topK, maxDistance, ...filterParams]
  );

  const results: QueryResultItem[] = result.rows.map((row: typeof result.rows[number]) => ({
    id: row.chunk_id,
    score: 1 - row.distance, // Convert distance to similarity score
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

  let graphResult: GraphResult | undefined;

  // Graph expansion: convert deprecated graphExpand to graph params
  const graphParams = request.graph ?? (request.graphExpand ? {} : null);
  if (graphParams !== null) {
    const backend = new SqlGraphBackend(pool);
    graphResult = await executeGraphStrategy(graphParams, results, backend);
  }

  const queryResult: QueryResult = { ok: true, results };
  if (graphResult) {
    queryResult.graph = graphResult;
  }

  return queryResult;
}
