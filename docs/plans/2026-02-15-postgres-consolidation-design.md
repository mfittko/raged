# Postgres Consolidation Design

## Overview

Replace Qdrant (vector DB), Neo4j (graph DB), and Redis (task queue) with a single Postgres instance using pgvector. SeaweedFS provides optional S3-compatible blob storage for large files.

This is a clean break — old storage code is deleted, not abstracted behind adapters.
Existing Qdrant/Neo4j/Redis data is not migrated in-place; this plan assumes re-indexing into Postgres from source repositories.
This project is currently greenfield and not yet deployed, so no backward-compatibility rollout is required.

## System context

```mermaid
graph TD
    EXT[Chrome Extension] -->|HTTP| API
    CLI[rag-index CLI] -->|HTTP| API
    AGENT[AI Agents] -->|HTTP| API

    API[RAG API] -->|embed| OL[Ollama]
    API -->|vectors + chunks + entities + queue| PG[Postgres + pgvector]
    API -->|large files| SWF[SeaweedFS / S3<br/>opt-in]

    WK[Enrichment Worker] -->|poll task_queue| PG
    WK -->|update chunks + entities| PG
    WK -->|extract| OL

    style API fill:#e1f5fe
    style PG fill:#f3e5f5
    style OL fill:#e8f5e9
    style MINIO fill:#fff9c4
    style WK fill:#e0f2f1
```

### Before vs after

```
Current (5 services)              Target (2-3 services)
──────────────────────────        ────────────────────────
Qdrant (vectors + payloads)    →  Postgres + pgvector
Neo4j (entities + graph)       →  Postgres (relational tables)
Redis (task queue)             →  Postgres (SKIP LOCKED)
— (no raw storage)             →  SeaweedFS (opt-in, large files)
Ollama (embeddings + LLM)     →  Ollama (unchanged)
```

### Docker Compose

```yaml
# Core (always)
postgres:    # Postgres 17 + pgvector
ollama:      # Unchanged

# Optional profiles
seaweedfs:   # --profile storage
worker:      # --profile enrichment (unchanged role)
```

### Environment variables

```
# Replaces: QDRANT_URL, QDRANT_COLLECTION, VECTOR_SIZE, DISTANCE,
#           NEO4J_URL, NEO4J_USER, NEO4J_PASSWORD, REDIS_URL
DATABASE_URL=postgresql://rag:rag@localhost:5432/ragstack

# Unchanged
ENRICHMENT_ENABLED=false

# New (optional, SeaweedFS S3)
BLOB_STORE_URL=http://localhost:8333
BLOB_STORE_ACCESS_KEY=<seaweedfs-access-key>
BLOB_STORE_SECRET_KEY=<seaweedfs-secret-key>
BLOB_STORE_BUCKET=rag-raw
BLOB_STORE_THRESHOLD_BYTES=10485760

# Note: VECTOR_SIZE is no longer runtime-configured in v1 of this design.
# The schema fixes embedding dimension to 768; changing model dimension requires a DB migration.
```

---

## Database schema

```sql
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
```

### Operation mappings

| Current | Postgres |
|---------|----------|
| document upsert | `INSERT INTO documents ... ON CONFLICT (collection, identity_key) DO UPDATE SET ...` |
| `qdrant.upsert(points)` | `INSERT INTO chunks ... ON CONFLICT (document_id, chunk_index) DO UPDATE` |
| `qdrant.search(vector, limit, filter)` | `SELECT ... FROM chunks WHERE <translated filter> ORDER BY embedding <=> $1 LIMIT $n` |
| `qdrant.scroll(filter)` | `SELECT ... WHERE <translated filter> LIMIT $n OFFSET $o` |
| `qdrant.set_payload()` | `UPDATE chunks SET tier2_meta = $1 WHERE id = $2` |
| Neo4j `MERGE Entity` | `INSERT INTO entities ... ON CONFLICT (name) DO UPDATE` |
| Neo4j graph traversal (1-2 hops) | JOIN or recursive CTE |
| Redis `LPUSH` (enqueue) | `INSERT INTO task_queue` |
| Redis `BRPOP` (dequeue) | `FOR UPDATE SKIP LOCKED` (polled) |
| Redis `LLEN` | `SELECT count(*) FROM task_queue WHERE status = 'pending'` |

Filter translation notes used by query/scroll:

- `repoId = X` -> `chunks.repo_id = $1`
- `lang = X` -> `chunks.lang = $1`
- `path prefix = P` -> `chunks.path LIKE ($1 || '%')`
- `enrichmentStatus = X` -> `chunks.enrichment_status = $1`
- URL/fetch/extraction metadata -> `documents.metadata->>'fetchedUrl'`, `resolvedUrl`, `contentType`, `fetchStatus`, `fetchedAt`, `extractionStrategy`, `extractedTitle`

Initial scope: support current CLI-compatible `must` filters for exact matches and path-prefix matching.

### Worker dequeue pattern

```sql
WITH next AS (
    SELECT id FROM task_queue
    WHERE queue = 'enrichment' AND status = 'pending' AND run_after <= now()
    ORDER BY run_after, created_at
    LIMIT 1
    FOR UPDATE SKIP LOCKED
)
UPDATE task_queue SET status = 'processing', started_at = now(),
    lease_expires_at = now() + interval '5 minutes', leased_by = $worker_id
FROM next WHERE task_queue.id = next.id
RETURNING *;
```

Stale-lease recovery pattern (worker watchdog):

```sql
UPDATE task_queue
SET status = 'pending',
        lease_expires_at = NULL,
        leased_by = NULL,
        run_after = now()
WHERE status = 'processing'
    AND lease_expires_at IS NOT NULL
    AND lease_expires_at < now();
```

Worker behavior: if this returns zero rows, sleep 1 s before retrying to avoid busy-looping. Under SKIP LOCKED contention zero-row results are expected and do not indicate an error.

### Blob storage behavior

- Files with size `<= BLOB_STORE_THRESHOLD_BYTES` stay in Postgres-only flow.
- Files with size `> BLOB_STORE_THRESHOLD_BYTES` store raw content in SeaweedFS (S3 API) with key `documents/{documents.id}/raw` (or extension variant) and persist key/size in `documents.raw_key` and `documents.raw_bytes`.
- Deleting a document must first delete its blob object (if present), then delete the `documents` row.
- A periodic orphan cleanup job can remove SeaweedFS objects with no matching `documents.raw_key`. Frequency and mechanism are implementation details — a daily cron or CLI subcommand is sufficient.

---

## Migration impact

### Files by component

**API — Delete:**
- `api/src/qdrant.ts` + test — Qdrant client
- `api/src/redis.ts` + test — Redis client
- `api/src/graph-client.ts` + test — Neo4j driver

**API — Create:**
- `api/src/db.ts` + test — Postgres pool, connection, migrations
- `api/migrations/001_initial.sql` — Schema

**API — Modify:**
- `api/src/server.ts` — Import db instead of qdrant/redis/graph-client
- `api/src/services/ingest.ts` — Document + chunks in transaction
- `api/src/services/query.ts` — Vector search via pgvector operator
- `api/src/services/enrichment.ts` — Status from chunks table, queue from task_queue, and `GET /enrichment/:baseId` via `documents.base_id`

**Worker — Delete:**
- `worker/src/graph.py` + test — Neo4j client

**Worker — Create:**
- `worker/src/db.py` + test — Postgres pool (asyncpg)

**Worker — Modify:**
- `worker/src/main.py` — SKIP LOCKED polling loop replaces Redis BRPOP
- `worker/src/pipeline.py` — SQL updates replace qdrant/graph calls
- `worker/src/config.py` — DATABASE_URL replaces QDRANT_URL/REDIS_URL/NEO4J_*

**CLI — Modify:**
- `cli/src/lib/utils.ts` — Remove qdrantFilter()
- `cli/src/commands/query.ts` — Pass filter params as plain objects

**Infrastructure — Modify:**
- `docker-compose.yml` — Replace qdrant + redis + neo4j with postgres + optional seaweedfs
- `.env.example` — DATABASE_URL replaces 6+ env vars
- `chart/templates/` — Delete qdrant/redis/neo4j YAMLs, add postgres-*.yaml
- `chart/values.yaml` — Postgres config block replaces three

### Dependency changes

| Component | Remove | Add |
|-----------|--------|-----|
| API (npm) | `@qdrant/js-client-rest`, `redis`, `neo4j-driver` | `pg` (vector ops via SQL against pgvector extension) |
| Worker (pip) | `qdrant-client`, `redis`, `neo4j` | `asyncpg`, `pgvector` (PyPI package) |

### Affected GitHub issues

| Issue | Impact |
|-------|--------|
| #35 Config & ops | Env vars change — DATABASE_URL replaces 6+ vars |
| #34 Worker quality | Worker storage layer rewritten — quality work should follow migration |
| #45 Chat Phase A | Should build on Postgres, not Qdrant |
| #42 Extension Phase 3 | `POST /items` becomes `SELECT * FROM documents` |
| #44 Extension Phase 5 | Reads tier2/tier3 from chunks table |
| #29 Codebase audit | Addresses config management and ops readiness items |

**Unaffected:** #38, #39, #40, #41, #43, #46, #47 — API consumers, not storage implementors.

### Ordering

```
Postgres consolidation (this)
  ├── then #35 Config & ops (rewrite against DATABASE_URL + Postgres healthcheck)
  ├── then #34 Worker quality (rewrite against new storage layer)
  ├── then #45 Chat Phase A (build on Postgres)
  └── then #42 Extension Phase 3 (POST /items = SELECT FROM documents)
```

- **This migration first.** #35 (config & ops) validates env vars like `QDRANT_URL` and adds healthchecks for Qdrant/Redis/Neo4j — all of which are deleted by this migration. Doing #35 first would be wasted work. After the migration, #35 becomes simpler: validate `DATABASE_URL` + `OLLAMA_URL`, add `pg_isready` healthcheck, warn on short API tokens.
- **#34 (worker quality) after.** The worker's storage layer is rewritten — linting and quality improvements should target the new code.
- **#45 and #42 after.** New features should build on Postgres, not the old stack.

---

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Single DB | Postgres 17 + pgvector | One backup, one connection, one service |
| Migration style | Clean break | No adapter complexity, old code deleted |
| Vector search | pgvector HNSW, cosine distance | Handles millions of 768d vectors |
| Graph storage | Relational tables + JOINs | Simple entity model, 1-2 hop lookups |
| Task queue | SKIP LOCKED polling | Atomic dequeue, no new dependency |
| Blob storage | SeaweedFS opt-in | S3-compatible, actively maintained (GitHub), large files only |
| Documents table | New first-class concept | Enables browse, raw file tracking, document metadata |
| DB client (API) | `pg` + SQL | Lightweight, no ORM; vector operations use Postgres `pgvector` extension |
| DB client (Worker) | `asyncpg` + `pgvector` | Async-native, works with asyncio loop |
| Schema migrations | SQL files in `api/migrations/` | Version-controlled, run on startup |
| Graph always on | Remove `isGraphEnabled()` gate | Graph is just tables — no reason to gate |
| Enrichment optional | Keep `ENRICHMENT_ENABLED` | Controls task enqueue, not table existence |
