import { getPool } from "../db.js";
import { translateFilter } from "../pg-helpers.js";
import { embed as embedTexts } from "../embeddings.js";
import type { FilterDSL } from "../pg-helpers.js";
import type { GraphParams } from "./graph-strategy.js";
import { executeGraphStrategy } from "./graph-strategy.js";
import { SqlGraphBackend } from "./sql-graph-backend.js";
import { classifyQuery } from "./query-router.js";
import type { RoutingResult, QueryStrategy } from "./query-router.js";
import { queryMetadata } from "./query-metadata.js";
import { hybridMetadataFlow, hybridGraphFlow } from "./hybrid-strategy.js";
import { extractStructuredFilter, isFilterLlmEnabled } from "./query-filter-parser.js";

export type { GraphParams, RoutingResult, QueryStrategy };

export interface QueryRequest {
  collection?: string;
  query?: string;
  topK?: number;
  minScore?: number;
  filter?: Record<string, unknown> | FilterDSL;
  /** @deprecated Use `graph` instead. */
  graphExpand?: boolean;
  graph?: GraphParams;
  /** Explicit strategy override; skips rule engine and LLM classifier. */
  strategy?: QueryStrategy;
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

import type { GraphResult } from "./graph-backend.js";
export type { GraphResult };

/** Base result shape returned by internal query implementations (routing is added by query()). */
export interface BaseQueryResult {
  ok: true;
  results: QueryResultItem[];
  graph?: GraphResult;
}

export interface QueryResult extends BaseQueryResult {
  routing: RoutingResult;
}

/**
 * Query documents using pgvector similarity search
 */
export async function query(
  request: QueryRequest,
  collection?: string,
): Promise<QueryResult> {
  const col = collection || "docs";

  // Classify the query intent
  const routing = await classifyQuery({
    query: request.query,
    filter: request.filter as Record<string, unknown> | undefined,
    graphExpand: request.graphExpand,
    strategy: request.strategy,
  });

  // LLM filter extraction: attempt to infer structured FilterDSL from natural
  // language when no explicit filter was provided and routing is ambiguous.
  // Only runs when ROUTER_FILTER_LLM_ENABLED=true (default: false).
  const hasExplicitFilter =
    request.filter !== undefined && request.filter !== null;
  const isAmbiguousRouting =
    routing.method === "default" || routing.method === "rule_fallback";
  const hasQuery = (request.query?.trim().length ?? 0) > 0;

  let effectiveFilter: FilterDSL | Record<string, unknown> | undefined =
    request.filter;

  if (!hasExplicitFilter && isAmbiguousRouting && hasQuery && isFilterLlmEnabled()) {
    const inferredFilter = await extractStructuredFilter({
      query: request.query as string,
      strategy: routing.strategy,
    });
    if (inferredFilter !== null) {
      effectiveFilter = inferredFilter;
      routing.inferredFilter = true;
    }
  }

  // Metadata-only path (no embedding)
  if (routing.strategy === "metadata") {
    const metaResult = await queryMetadata(
      { collection: col, topK: request.topK, filter: effectiveFilter },
      col,
    );
    return { ...metaResult, routing };
  }

  const queryText = request.query?.trim() ?? "";
  if (queryText.length === 0) {
    throw new Error("Query text is required for semantic, graph, and hybrid strategies");
  }

  // Hybrid path: metadata → semantic rerank (filter present, no graphExpand)
  // or graph → semantic rerank (graphExpand, explicit graph params, or no filter).
  // Flow discriminator: if a filter is present AND no graph expansion is requested,
  // use Flow 1 (metadata candidates → semantic rerank). Otherwise use Flow 2
  // (graph traversal → semantic rerank), which also handles the router's
  // `relational_pattern` rule that emits `hybrid` with no filter or graphExpand.
  if (routing.strategy === "hybrid") {
    const topK = request.topK ?? 8;
    const minScore = request.minScore ?? getAutoMinScore(queryText);
    const hasFilter = effectiveFilter !== undefined && effectiveFilter !== null;
    const hasGraphExpand = (request.graphExpand === true) || (request.graph !== undefined);

    if (hasGraphExpand || !hasFilter) {
      // Flow 2: graph → semantic rerank
      const backend = new SqlGraphBackend(getPool());
      const hybridResult = await hybridGraphFlow(
        { collection: col, query: queryText, topK, minScore, graph: request.graph },
        backend,
      );
      return { ...hybridResult, routing };
    } else {
      // Flow 1: metadata → semantic rerank (filter is present, no graph expansion)
      const hybridResult = await hybridMetadataFlow({
        collection: col,
        query: queryText,
        topK,
        minScore,
        filter: effectiveFilter,
      });
      return { ...hybridResult, routing };
    }
  }

  const vectors = await embedTexts([queryText]);
  const [vector] = vectors;
  if (!vector) {
    throw new Error("Embedding failed: no vector returned");
  }
  const topK = request.topK ?? 8;
  const minScore = request.minScore ?? getAutoMinScore(queryText);
  const maxDistance = 1 - minScore;

  // Translate filter to Postgres WHERE clause (offset by 4 for base params: $1=collection, $2=vector, $3=topK, $4=maxDistance)
  const { sql: filterSql, params: filterParams } = translateFilter(effectiveFilter, 4);

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

  // Graph expansion: convert deprecated graphExpand to graph params.
  // Intentional router behavior: classified "graph" strategy enables graph
  // expansion with default params even without explicit graphExpand.
  const graphParams =
    routing.strategy === "graph"
      ? (request.graph ?? {})
      : (request.graph ?? (request.graphExpand ? {} : null));
  if (graphParams !== null) {
    const backend = new SqlGraphBackend(pool);
    graphResult = await executeGraphStrategy(graphParams, results, backend);
  }

  const queryResult: QueryResult = { ok: true, results, routing };
  if (graphResult) {
    queryResult.graph = graphResult;
  }

  return queryResult;
}
