import { getPool } from "../db.js";

export interface CollectionStats {
  collection: string;
  documentCount: number;
  chunkCount: number;
  enrichedChunkCount: number;
  lastSeenAt: string | null;
}

export interface ListCollectionsResult {
  ok: true;
  collections: CollectionStats[];
}

export async function listCollections(): Promise<ListCollectionsResult> {
  const pool = getPool();

  const result = await pool.query<{
    collection: string;
    document_count: number;
    chunk_count: number;
    enriched_chunk_count: number;
    last_seen_at: string | null;
  }>(
    `SELECT d.collection,
      COUNT(DISTINCT d.id)::int AS document_count,
      COUNT(c.id)::int AS chunk_count,
      COUNT(*) FILTER (WHERE c.enrichment_status = 'enriched')::int AS enriched_chunk_count,
      MAX(d.last_seen)::text AS last_seen_at
    FROM documents d LEFT JOIN chunks c ON c.document_id = d.id
    GROUP BY d.collection
    ORDER BY COUNT(DISTINCT d.id) DESC, d.collection ASC`
  );

  const collections: CollectionStats[] = result.rows.map((row) => ({
    collection: row.collection,
    documentCount: row.document_count,
    chunkCount: row.chunk_count,
    enrichedChunkCount: row.enriched_chunk_count,
    lastSeenAt: row.last_seen_at,
  }));

  return { ok: true, collections };
}
