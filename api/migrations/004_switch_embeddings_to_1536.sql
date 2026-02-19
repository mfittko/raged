-- Switch embedding vector dimension to 1536 for OpenAI-compatible models
-- NOTE: Existing embeddings are dropped because vector dimensions cannot be cast from 768 -> 1536.
-- Re-ingest (or re-enrich with re-embedding) is required after this migration.

DROP INDEX IF EXISTS idx_chunks_embedding;

ALTER TABLE chunks DROP COLUMN embedding;
ALTER TABLE chunks ADD COLUMN embedding vector(1536);

CREATE INDEX idx_chunks_embedding ON chunks
    USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);