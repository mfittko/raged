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

export interface SearchHit {
  id: string | number;
  score: number;
  payload?: Record<string, unknown>;
}

export interface QueryDeps {
  embed: (texts: string[]) => Promise<number[][]>;
  ensureCollection: (name: string) => Promise<void>;
  search: (
    collection: string,
    vector: number[],
    limit: number,
    filter?: Record<string, unknown>,
  ) => Promise<SearchHit[]>;
  collectionName: (name?: string) => string;
  /**
   * Optional: Expands entities in Neo4j graph.
   * Provide when graph functionality is enabled to support graphExpand queries.
   * @param entityNames - Array of entity names to expand from
   * @param depth - How many hops to traverse (default 2)
   * @returns Array of connected entities
   */
  expandEntities?: (entityNames: string[], depth?: number) => Promise<Array<{ name: string; type: string }>>;
}

export async function query(
  request: QueryRequest,
  deps: QueryDeps,
): Promise<QueryResult> {
  const col = deps.collectionName(request.collection);
  await deps.ensureCollection(col);

  const vectors = await deps.embed([request.query]);
  const [vector] = vectors;
  if (!vector) {
    throw new Error("Embedding failed: no vector returned");
  }
  const topK = request.topK ?? 8;

  const hits = await deps.search(col, vector, topK, request.filter);

  let results: QueryResultItem[] = hits.map((hit) => ({
    id: hit.id,
    score: hit.score,
    source: hit.payload?.source as string | undefined,
    text: hit.payload?.text as string | undefined,
    payload: hit.payload,
  }));

  let graphData: GraphData | undefined;

  // Graph expansion if requested
  if (request.graphExpand && deps.expandEntities) {
    // Extract entity names from tier2/tier3 metadata in results
    const entityNames = new Set<string>();
    for (const result of results) {
      const tier2Meta = result.payload?.tier2Meta as Record<string, unknown> | undefined;
      const tier3Meta = result.payload?.tier3Meta as Record<string, unknown> | undefined;

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
      // Expand entities in the graph
      const expandedEntities = await deps.expandEntities(Array.from(entityNames), 2);
      
      // Extract unique entity names from expanded results
      const allEntityNames = new Set([...entityNames, ...expandedEntities.map(e => e.name)]);
      
      // Build graph data structure
      graphData = {
        entities: Array.from(allEntityNames).map(name => {
          const entity = expandedEntities.find(e => e.name === name);
          return {
            name,
            type: entity?.type || "unknown",
          };
        }),
        relationships: [],
      };

      // Optionally fetch additional documents that mention these entities
      // For simplicity, we'll just include the graph structure for now
    }
  }

  const result: QueryResult = { ok: true, results };
  if (graphData) {
    result.graph = graphData;
  }

  return result;
}
