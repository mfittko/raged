export interface QueryRequest {
  collection?: string;
  query: string;
  topK?: number;
  filter?: Record<string, unknown>;
}

export interface QueryResultItem {
  id: string | number;
  score: number;
  source?: string;
  text?: string;
  payload?: Record<string, unknown>;
}

export interface QueryResult {
  ok: true;
  results: QueryResultItem[];
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

  const results: QueryResultItem[] = hits.map((hit) => ({
    id: hit.id,
    score: hit.score,
    source: hit.payload?.source as string | undefined,
    text: hit.payload?.text as string | undefined,
    payload: hit.payload,
  }));

  return { ok: true, results };
}
