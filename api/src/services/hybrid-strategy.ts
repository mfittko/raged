/**
 * Hybrid execution strategy: combines structured-retrieval (metadata filter OR
 * graph traversal) with a semantic rerank phase to produce a single ranked
 * result list bounded by the caller-supplied topK limit.
 *
 * Two flows are supported:
 *   Flow 1: Metadata → Semantic Rerank (filter present, no graphExpand)
 *   Flow 2: Graph    → Semantic Rerank (graphExpand: true)
 */

import { getPool } from "../db.js";
import { translateFilter } from "../pg-helpers.js";
import { embed as embedTexts } from "../embeddings.js";
import type { FilterDSL } from "../pg-helpers.js";
import type { GraphBackend, GraphResult, TraversalParams, EntityDocument } from "./graph-backend.js";
import type { QueryResultItem, BaseQueryResult } from "./query.js";
import type { GraphParams } from "./graph-strategy.js";

// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------

/**
 * Phase-1 candidate multiplier: candidate limit = min(topK × this, 500).
 * Controls how many metadata/graph candidates are considered before reranking.
 */
const CANDIDATE_MULTIPLIER = 5;

/**
 * Maximum number of candidates fetched in the first phase, regardless of topK.
 */
const CANDIDATE_CAP = 500;

/**
 * Initial semantic search limit used in Flow 2 for entity extraction.
 * The first semantic pass retrieves this many results to identify graph seeds.
 */
const SEED_LIMIT = 20;

/**
 * Clamps mention counts for normalisation so that the boost stays in [0, 1].
 * A chunk mentioned MENTION_CAP or more times receives a full boost of 1.0.
 */
const MENTION_CAP = 10;

/**
 * Weight applied to the cosine similarity score in the graph-pool blended formula.
 * Must sum to 1.0 with MENTION_WEIGHT.
 */
const SEMANTIC_WEIGHT = 0.85;

/**
 * Weight applied to the mention-count boost in the graph-pool blended formula.
 * Must sum to 1.0 with SEMANTIC_WEIGHT.
 */
const MENTION_WEIGHT = 0.15;

// ---------------------------------------------------------------------------
// Invariant: weights must sum to 1.0
// ---------------------------------------------------------------------------
/* istanbul ignore next */
if (Math.abs(SEMANTIC_WEIGHT + MENTION_WEIGHT - 1.0) > 1e-9) {
  throw new Error(
    `[hybrid-strategy] SEMANTIC_WEIGHT (${SEMANTIC_WEIGHT}) + MENTION_WEIGHT (${MENTION_WEIGHT}) must equal 1.0`,
  );
}

// ---------------------------------------------------------------------------
// Shared row type returned by the semantic rerank SQL query
// ---------------------------------------------------------------------------
interface RerankRow {
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
}

/** Flow 2 rerank row — extends RerankRow with the document's UUID for mention lookup. */
interface GraphRerankRow extends RerankRow {
  /** documents.id — the document UUID, distinct from the chunk's own UUID. */
  document_id: string;
}

function rowToResultItem(row: RerankRow, score: number): QueryResultItem {
  return {
    id: row.chunk_id,
    score,
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
  };
}

// ---------------------------------------------------------------------------
// Seed entity extraction (reused from graph-strategy logic)
// ---------------------------------------------------------------------------

const MAX_ENTITY_NAMES = 50;

export function extractEntityNamesFromResults(results: QueryResultItem[]): string[] {
  const seen = new Set<string>();
  const names: string[] = [];

  for (const item of results) {
    const tier2Meta = item.payload?.tier2Meta as Record<string, unknown> | undefined;
    const tier3Meta = item.payload?.tier3Meta as Record<string, unknown> | undefined;

    if (Array.isArray(tier2Meta?.entities)) {
      for (const entity of tier2Meta.entities as Array<{ text: string }>) {
        const lower = entity.text?.toLowerCase();
        if (lower && !seen.has(lower)) {
          seen.add(lower);
          names.push(entity.text);
        }
      }
    }

    if (Array.isArray(tier3Meta?.entities)) {
      for (const entity of tier3Meta.entities as Array<{ name: string }>) {
        const lower = entity.name?.toLowerCase();
        if (lower && !seen.has(lower)) {
          seen.add(lower);
          names.push(entity.name);
        }
      }
    }
  }

  return names.slice(0, MAX_ENTITY_NAMES);
}

// ---------------------------------------------------------------------------
// Merge / rerank algorithm (Flow 2)
// ---------------------------------------------------------------------------

export interface GraphPoolEntry {
  item: QueryResultItem;
  /** Pre-computed semantic similarity score (1 - cosine_distance) for this chunk. */
  semanticScore: number;
  /** Mention count from graph entity documents (used for mentionBoost). */
  mentionCount: number;
}

export interface SeedPoolEntry {
  item: QueryResultItem;
  /** Raw semantic similarity score (1 - cosine_distance). */
  semanticScore: number;
}

/**
 * Merge graph-pool and seed-pool results, applying blended scoring for graph
 * pool chunks and raw similarity for seed-only chunks.
 *
 * Deduplication: if a chunk appears in both pools, the graph pool score wins.
 *
 * @param graphPool  Chunks from connected documents with mention counts.
 * @param seedPool   Initial semantic search results.
 * @param topK       Maximum number of results to return.
 * @param minScore   Minimum effective score (inclusive lower bound).
 */
export function mergeAndRerankGraphResults(
  graphPool: GraphPoolEntry[],
  seedPool: SeedPoolEntry[],
  topK: number,
  minScore: number,
): QueryResultItem[] {
  // Build merged map: chunk ID → { item, effectiveScore }
  // Graph pool takes precedence on collisions.
  const merged = new Map<string, { item: QueryResultItem; score: number }>();

  for (const entry of graphPool) {
    const mentionBoost = Math.min(entry.mentionCount, MENTION_CAP) / MENTION_CAP;
    const effectiveScore = SEMANTIC_WEIGHT * entry.semanticScore + MENTION_WEIGHT * mentionBoost;
    merged.set(String(entry.item.id), { item: entry.item, score: effectiveScore });
  }

  for (const entry of seedPool) {
    const id = String(entry.item.id);
    if (!merged.has(id)) {
      merged.set(id, { item: entry.item, score: entry.semanticScore });
    }
    // If already present (graph pool), skip — graph pool score takes precedence
  }

  return Array.from(merged.values())
    .filter(({ score }) => score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(({ item, score }) => ({ ...item, score }));
}

// ---------------------------------------------------------------------------
// Flow 1: Metadata → Semantic Rerank
// ---------------------------------------------------------------------------

export interface HybridMetadataRequest {
  collection: string;
  query: string;
  topK: number;
  minScore: number;
  filter?: Record<string, unknown> | FilterDSL;
}

/**
 * Flow 1: Metadata → Semantic Rerank.
 *
 * Phase 1: retrieve candidates by applying the metadata filter (no embedding).
 *   Candidate limit = min(topK × CANDIDATE_MULTIPLIER, CANDIDATE_CAP).
 *
 * Phase 2 (skipped when candidates empty): embed(query) once, then rerank
 *   candidates by cosine similarity. `minScore` is applied to final scores.
 *
 * embed() is called exactly once (or not at all when no candidates).
 */
export async function hybridMetadataFlow(
  request: HybridMetadataRequest,
): Promise<BaseQueryResult> {
  const { collection: col, query: queryText, topK, minScore, filter } = request;
  const candidateLimit = Math.min(topK * CANDIDATE_MULTIPLIER, CANDIDATE_CAP);

  const pool = getPool();

  // -------------------------------------------------------------------------
  // Phase 1: retrieve candidate IDs via metadata filter (no embedding)
  // Filters to rows with embeddings so Phase 2 never sees null-embedding rows.
  // Required index: chunks(document_id) + documents(collection) — standard FK index.
  // For large collections, a composite index on (document_id, created_at) improves ORDER BY.
  // -------------------------------------------------------------------------
  const { sql: filterSql, params: filterParams } = translateFilter(filter, 2);

  const candidateResult = await pool.query<{ chunk_uuid: string }>(
    `SELECT c.id::text AS chunk_uuid
     FROM chunks c
     JOIN documents d ON c.document_id = d.id
     WHERE d.collection = $1
       AND c.embedding IS NOT NULL${filterSql}
     ORDER BY c.created_at DESC
     LIMIT $2`,
    [col, candidateLimit, ...filterParams],
  );

  if (candidateResult.rows.length === 0) {
    return { ok: true, results: [] };
  }

  const candidateUuids = candidateResult.rows.map((r) => r.chunk_uuid);

  // -------------------------------------------------------------------------
  // Phase 2: embed query once, rerank candidates by cosine similarity
  // -------------------------------------------------------------------------
  const vectors = await embedTexts([queryText]);
  const [vector] = vectors;
  if (!vector) {
    throw new Error("Embedding failed: no vector returned");
  }

  // Single batch query — no N+1 pattern.
  // Uses the primary key index on chunks(id) via ANY($3::uuid[]).
  const rerankResult = await pool.query<RerankRow>(
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
     WHERE c.id = ANY($3::uuid[])
     ORDER BY c.embedding <=> $2::vector
     LIMIT $1`,
    [candidateLimit, JSON.stringify(vector), candidateUuids],
  );

  const results: QueryResultItem[] = rerankResult.rows
    .map((row) => {
      const score = 1 - row.distance;
      return rowToResultItem(row, score);
    })
    .filter((item) => item.score >= minScore)
    .slice(0, topK);

  return { ok: true, results };
}

// ---------------------------------------------------------------------------
// Flow 2: Graph → Semantic Rerank
// ---------------------------------------------------------------------------

export interface HybridGraphRequest {
  collection: string;
  query: string;
  topK: number;
  minScore: number;
  graph?: GraphParams;
}

const DEFAULT_MAX_DEPTH = 2;
const DEFAULT_MAX_ENTITIES = 50;
const TRAVERSAL_TIME_LIMIT_MS = 5000;

/**
 * Flow 2: Graph → Semantic Rerank.
 *
 * 1. embed(query) — exactly once; vector reused for seed search and rerank.
 * 2. Initial semantic seed search (SEED_LIMIT results).
 * 3. Extract entity names from seed payloads.
 * 4. Resolve entity names → IDs via GraphBackend.resolveEntities().
 * 5. BFS traversal via GraphBackend.traverse() with includeDocuments: false.
 * 6. Fetch connected-document chunks via GraphBackend.getEntityDocuments().
 * 7. Rerank connected-doc chunks by cosine similarity (single batch query).
 * 8. Merge graph pool + seed pool using blended scoring; deduplicate; topK.
 *
 * Fallback: if no entity names extracted or graph returns no documents →
 * return seed results (sliced to topK, minScore applied).
 */
export async function hybridGraphFlow(
  request: HybridGraphRequest,
  backend: GraphBackend,
): Promise<BaseQueryResult> {
  const { collection: col, query: queryText, topK, minScore, graph: graphParams } = request;
  const candidateLimit = Math.min(topK * CANDIDATE_MULTIPLIER, CANDIDATE_CAP);

  // -------------------------------------------------------------------------
  // Step 1: embed query exactly once
  // -------------------------------------------------------------------------
  const vectors = await embedTexts([queryText]);
  const [vector] = vectors;
  if (!vector) {
    throw new Error("Embedding failed: no vector returned");
  }

  const pool = getPool();

  // -------------------------------------------------------------------------
  // Step 2: initial semantic seed search
  // -------------------------------------------------------------------------
  const seedResult = await pool.query<RerankRow>(
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
     ORDER BY c.embedding <=> $2::vector
     LIMIT $3`,
    [col, JSON.stringify(vector), SEED_LIMIT],
  );

  const seedItems: QueryResultItem[] = seedResult.rows.map((row) =>
    rowToResultItem(row, 1 - row.distance),
  );

  // -------------------------------------------------------------------------
  // Step 3: extract entity names from seed payloads
  // -------------------------------------------------------------------------
  const entityNames = extractEntityNamesFromResults(seedItems);

  if (entityNames.length === 0) {
    // Empty graph fallback: no entities found → return seed results with empty graph
    const filteredSeed = seedItems
      .filter((item) => item.score >= minScore)
      .slice(0, topK);
    const emptyGraph: GraphResult = {
      entities: [],
      relationships: [],
      paths: [],
      documents: [],
      meta: {
        seedEntities: [],
        seedSource: "results",
        maxDepthUsed: graphParams?.maxDepth ?? DEFAULT_MAX_DEPTH,
        entityCount: 0,
        entityCap: graphParams?.maxEntities ?? DEFAULT_MAX_ENTITIES,
        capped: false,
        timeLimitMs: TRAVERSAL_TIME_LIMIT_MS,
        timedOut: false,
        warnings: ["No entities found in seed results to seed the graph"],
      },
    };
    return { ok: true, results: filteredSeed, graph: emptyGraph };
  }

  // -------------------------------------------------------------------------
  // Step 4: resolve entity names → IDs
  // -------------------------------------------------------------------------
  const resolvedEntities = await backend.resolveEntities(entityNames);

  if (resolvedEntities.length === 0) {
    const filteredSeed = seedItems
      .filter((item) => item.score >= minScore)
      .slice(0, topK);
    const emptyGraph: GraphResult = {
      entities: [],
      relationships: [],
      paths: [],
      documents: [],
      meta: {
        seedEntities: entityNames,
        seedSource: "results",
        maxDepthUsed: graphParams?.maxDepth ?? DEFAULT_MAX_DEPTH,
        entityCount: 0,
        entityCap: graphParams?.maxEntities ?? DEFAULT_MAX_ENTITIES,
        capped: false,
        timeLimitMs: TRAVERSAL_TIME_LIMIT_MS,
        timedOut: false,
        warnings: ["None of the seed entities could be resolved"],
      },
    };
    return { ok: true, results: filteredSeed, graph: emptyGraph };
  }

  const seedEntityIds = resolvedEntities.map((e) => e.id);

  // -------------------------------------------------------------------------
  // Step 5: BFS traversal — includeDocuments: false so we control candidate limit
  // -------------------------------------------------------------------------
  const traversalParams: TraversalParams = {
    maxDepth: graphParams?.maxDepth ?? DEFAULT_MAX_DEPTH,
    maxEntities: graphParams?.maxEntities ?? DEFAULT_MAX_ENTITIES,
    relationshipTypes: graphParams?.relationshipTypes ?? [],
    includeDocuments: false,
    timeLimitMs: TRAVERSAL_TIME_LIMIT_MS,
  };

  const traversalResult = await backend.traverse(seedEntityIds, traversalParams);

  // -------------------------------------------------------------------------
  // Step 6: fetch connected-document entity docs (single batch call, no N+1)
  // -------------------------------------------------------------------------
  // graphEntityIds includes all entities from the traversal (seeds + connected).
  // getEntityDocuments returns document associations for all of them.
  const graphEntityIds = traversalResult.entities.map((e) => e.id);

  let entityDocs: EntityDocument[] = [];
  if (graphEntityIds.length > 0) {
    entityDocs = await backend.getEntityDocuments(graphEntityIds, candidateLimit);
  }

  // Build graph result for response (documents omitted — they appear in results[])
  const graphResultForResponse: GraphResult = {
    entities: traversalResult.entities.map((e) => ({
      name: e.name,
      type: e.type,
      depth: e.depth,
      isSeed: e.isSeed,
      mentionCount: e.mentionCount,
    })),
    relationships: traversalResult.relationships,
    paths: traversalResult.paths,
    documents: [],
    meta: { ...traversalResult.meta, seedSource: "results" },
  };

  if (entityDocs.length === 0) {
    // Empty graph fallback: graph found entities but no documents
    const filteredSeed = seedItems
      .filter((item) => item.score >= minScore)
      .slice(0, topK);
    return { ok: true, results: filteredSeed, graph: graphResultForResponse };
  }

  // -------------------------------------------------------------------------
  // Step 7: rerank connected-document chunks by cosine similarity (single batch)
  // -------------------------------------------------------------------------
  const connectedDocIds = [...new Set(entityDocs.map((d) => d.documentId))];

  const rerankResult = await pool.query<GraphRerankRow>(
    `SELECT
       c.id::text || ':' || c.chunk_index::text AS chunk_id,
       d.id::text AS document_id,
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
     WHERE c.document_id = ANY($3::uuid[])
       AND c.embedding IS NOT NULL
     ORDER BY c.embedding <=> $2::vector
     LIMIT $1`,
    [candidateLimit, JSON.stringify(vector), connectedDocIds],
  );

  // -------------------------------------------------------------------------
  // Step 8: merge graph pool + seed pool with blended scoring
  // -------------------------------------------------------------------------

  // Build mention-count lookup: documentId → max mentionCount for that doc.
  // Max is used so that a document with multiple entity mentions gets the
  // highest individual entity mention count (most prominent entity wins).
  const mentionByDoc = new Map<string, number>();
  for (const doc of entityDocs) {
    const current = mentionByDoc.get(doc.documentId) ?? 0;
    if (doc.mentionCount > current) {
      mentionByDoc.set(doc.documentId, doc.mentionCount);
    }
  }

  // row.document_id is documents.id (selected as d.id::text in the rerank SQL).
  // This is the correct key for mentionByDoc — distinct from chunks.id in chunk_id.
  const graphPool: GraphPoolEntry[] = rerankResult.rows.map((row) => {
    const semanticScore = 1 - row.distance;
    const mentionCount = mentionByDoc.get(row.document_id) ?? 0;
    return { item: rowToResultItem(row, semanticScore), semanticScore, mentionCount };
  });

  const seedPool: SeedPoolEntry[] = seedItems.map((item) => ({
    item,
    semanticScore: item.score,
  }));

  const merged = mergeAndRerankGraphResults(graphPool, seedPool, topK, minScore);

  return { ok: true, results: merged, graph: graphResultForResponse };
}
