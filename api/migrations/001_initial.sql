-- Initial schema for Postgres consolidation
-- Replaces Qdrant (vectors), Neo4j (graph), and Redis (task queue)

-- Extensions
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Documents (new first-class concept, currently implicit via baseId)
CREATE TABLE documents (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Legacy identifier kept for compatibility with /enrichment/:baseId lookups.
    -- Nullable: new documents created after the migration do not need a base_id.
    base_id       TEXT UNIQUE,
    -- Natural identity key for idempotent re-ingest (derived from canonical source path/URL)
    identity_key  TEXT NOT NULL,
    source        TEXT NOT NULL,
    -- Canonical source URL; ingest maps item.url -> documents.item_url
    item_url      TEXT,
    doc_type      TEXT,
    collection    TEXT NOT NULL DEFAULT 'docs',
    repo_id       TEXT,
    repo_url      TEXT,
    path          TEXT,
    lang          TEXT,
    title         TEXT,
    summary       TEXT,
    metadata      JSONB,
    raw_key       TEXT,
    -- Raw object size in bytes when a blob is stored
    raw_bytes     BIGINT,
    mime_type     TEXT,
    created_at    TIMESTAMPTZ DEFAULT now(),
    updated_at    TIMESTAMPTZ DEFAULT now(),
    ingested_at   TIMESTAMPTZ DEFAULT now(),
    last_seen     TIMESTAMPTZ DEFAULT now(),
    UNIQUE(collection, identity_key)
);

CREATE INDEX idx_documents_source ON documents (source);
CREATE INDEX idx_documents_collection ON documents (collection);
CREATE INDEX idx_documents_repo_id ON documents (repo_id);
CREATE INDEX idx_documents_doc_type ON documents (doc_type);
CREATE INDEX idx_documents_path ON documents (path);
CREATE INDEX idx_documents_lang ON documents (lang);

-- Keep freshness timestamps correct on update/re-ingest
-- ingested_at is immutable and represents first ingest time only.
CREATE FUNCTION touch_documents_timestamps()
RETURNS trigger AS $$
BEGIN
    NEW.updated_at := now();
    NEW.last_seen := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_documents_touch
BEFORE UPDATE ON documents
FOR EACH ROW
EXECUTE FUNCTION touch_documents_timestamps();

-- Chunks (replaces Qdrant points)
CREATE TABLE chunks (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id         UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    chunk_index         INT NOT NULL,
    text                TEXT NOT NULL,
    -- 768 matches the default embedding model in this project (nomic-embed-text).
    -- If model dimension changes, alter this column and rebuild vector indexes.
    embedding           vector(768),
    -- Denormalized filter fields for fast filtered vector search
    repo_id             TEXT,
    repo_url            TEXT,
    path                TEXT,
    lang                TEXT,
    doc_type            TEXT,
    item_url            TEXT,
    enrichment_status   TEXT NOT NULL DEFAULT 'none'
                        CHECK (enrichment_status IN ('none','pending','processing','enriched','failed')),
    tier1_meta          JSONB,
    tier2_meta          JSONB,
    tier3_meta          JSONB,
    enriched_at         TIMESTAMPTZ,
    created_at          TIMESTAMPTZ DEFAULT now(),
    UNIQUE(document_id, chunk_index)
);

CREATE INDEX idx_chunks_embedding ON chunks
    USING hnsw (embedding vector_cosine_ops);
CREATE INDEX idx_chunks_document_id ON chunks (document_id);
CREATE INDEX idx_chunks_enrichment_status ON chunks (enrichment_status);
CREATE INDEX idx_chunks_repo_id ON chunks (repo_id);
CREATE INDEX idx_chunks_path ON chunks (path);
CREATE INDEX idx_chunks_path_prefix ON chunks (path text_pattern_ops);
CREATE INDEX idx_chunks_lang ON chunks (lang);
CREATE INDEX idx_chunks_doc_type ON chunks (doc_type);

-- Entities (replaces Neo4j Entity nodes)
CREATE TABLE entities (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL UNIQUE,
    type            TEXT,
    description     TEXT,
    mention_count   INT DEFAULT 0,
    first_seen      TIMESTAMPTZ DEFAULT now(),
    last_seen       TIMESTAMPTZ DEFAULT now()
);

-- Entity relationships (replaces Neo4j RELATES_TO edges)
CREATE TABLE entity_relationships (
    source_id           UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    target_id           UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    relationship_type   TEXT NOT NULL,
    description         TEXT,
    created_at          TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (source_id, target_id, relationship_type)
);

CREATE INDEX idx_entity_relationships_target_id ON entity_relationships (target_id);

-- Document-entity mentions (replaces Neo4j MENTIONS edges)
-- document_id references documents.id (UUID), not the legacy base_id string.
CREATE TABLE document_entity_mentions (
    document_id     UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    entity_id       UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    mention_count   INT DEFAULT 1,
    first_seen      TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (document_id, entity_id)
);

CREATE INDEX idx_mentions_entity_id ON document_entity_mentions (entity_id);

-- Task queue (replaces Redis enrichment:pending + dead-letter)
CREATE TABLE task_queue (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    queue           TEXT NOT NULL DEFAULT 'enrichment',
    -- dead status replaces Redis dead-letter queue as an in-table terminal state
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','processing','completed','failed','dead')),
    payload         JSONB NOT NULL,
    attempt         INT DEFAULT 1,
    max_attempts    INT DEFAULT 3,
    -- run_after is the SQL equivalent of retryAfter in the current worker payload model
    run_after       TIMESTAMPTZ DEFAULT now(),
    lease_expires_at TIMESTAMPTZ,
    leased_by        TEXT,
    started_at      TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,
    error           TEXT,
    created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_task_queue_dequeue
    ON task_queue (queue, run_after, created_at)
    WHERE status = 'pending';

CREATE INDEX idx_task_queue_stale_processing
    ON task_queue (queue, lease_expires_at)
    WHERE status = 'processing';
