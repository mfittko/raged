import { getPool } from "../db.js";
import { translateFilter } from "../pg-helpers.js";
import { embed as embedTexts } from "../ollama.js";

export interface QueryRequest {
  collection?: string;
  query: string;
  topK?: number;
  filter?: Record<string, unknown>;
  graphExpand?: boolean;
}

export interface QueryResultItem {
  id: string | number;
  score: number;
  source?: string;
  text?: string;
  payload?: Record<string, unknown>;
}

export interface GraphData {
  entities: Array<{
    name: string;
    type: string;
    mentionCount?: number;
  }>;
  relationships: Array<{
    source: string;
    target: string;
    type: string;
  }>;
}

export interface QueryResult {
  ok: true;
  results: QueryResultItem[];
  graph?: GraphData;
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

  // Translate filter to Postgres WHERE clause (offset by 3 for base params: $1=collection, $2=vector, $3=topK)
  const { sql: filterSql, params: filterParams } = translateFilter(request.filter, 3);

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
      c.tier3_meta
    FROM chunks c
    JOIN documents d ON c.document_id = d.id
    WHERE d.collection = $1${filterSql}
    ORDER BY c.embedding <=> $2::vector
    LIMIT $3`,
    [col, JSON.stringify(vector), topK, ...filterParams]
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
    },
  }));

  let graphData: GraphData | undefined;

  // Graph expansion if requested
  if (request.graphExpand) {
    // Extract entity names from tier2/tier3 metadata in results
    const entityNames = new Set<string>();
    for (const resultItem of results) {
      const tier2Meta = resultItem.payload?.tier2Meta as Record<string, unknown> | undefined;
      const tier3Meta = resultItem.payload?.tier3Meta as Record<string, unknown> | undefined;

      if (tier2Meta?.entities) {
        const entities = tier2Meta.entities as Array<{ text: string }>;
        for (const entity of entities) {
          entityNames.add(entity.text);
        }
      }

      if (tier3Meta?.entities) {
        const entities = tier3Meta.entities as Array<{ name: string }>;
        for (const entity of entities) {
          entityNames.add(entity.name);
        }
      }
    }

    if (entityNames.size > 0) {
      // Expand entities from the Postgres graph (2-hop traversal)
      const expandedResult = await pool.query<{ name: string; type: string | null }>(
        `WITH RECURSIVE entity_graph AS (
          -- Base case: entities mentioned in results
          SELECT e.id, e.name, e.type, 0 AS depth, ARRAY[e.id] AS path
          FROM entities e
          WHERE e.name = ANY($1::text[])
          
          UNION
          
          -- Recursive case: entities connected via relationships (up to 2 hops)
          SELECT e.id, e.name, e.type, eg.depth + 1, eg.path || e.id
          FROM entity_graph eg
          JOIN entity_relationships er ON er.source_id = eg.id OR er.target_id = eg.id
          JOIN entities e ON e.id = CASE 
            WHEN er.source_id = eg.id THEN er.target_id
            ELSE er.source_id
          END
          WHERE eg.depth < 2
            AND e.id <> ALL(eg.path)
        )
        SELECT DISTINCT name, type
        FROM entity_graph`,
        [Array.from(entityNames)]
      );

      const expandedEntities = expandedResult.rows;

      // Fetch relationships between expanded entities
      const relationshipsResult = await pool.query<{
        source_name: string;
        target_name: string;
        relationship_type: string;
      }>(
        `SELECT 
          es.name AS source_name,
          et.name AS target_name,
          er.relationship_type
        FROM entity_relationships er
        JOIN entities es ON er.source_id = es.id
        JOIN entities et ON er.target_id = et.id
        WHERE es.name = ANY($1::text[]) OR et.name = ANY($1::text[])`,
        [Array.from(entityNames)]
      );

      graphData = {
        entities: expandedEntities.map(e => ({
          name: e.name,
          type: e.type || "unknown",
        })),
        relationships: relationshipsResult.rows.map((r) => ({
          source: r.source_name,
          target: r.target_name,
          type: r.relationship_type,
        })),
      };
    }
  }

  const queryResult: QueryResult = { ok: true, results };
  if (graphData) {
    queryResult.graph = graphData;
  }

  return queryResult;
}
