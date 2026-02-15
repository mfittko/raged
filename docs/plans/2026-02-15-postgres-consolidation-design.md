# Postgres Consolidation Design

## Overview

Replace Qdrant (vector DB), Neo4j (graph DB), and Redis (task queue) with a single Postgres instance using pgvector. MinIO provides optional S3-compatible blob storage for large files.

This is a clean break — old storage code is deleted, not abstracted behind adapters.

## System context

```mermaid
graph TD
    EXT[Chrome Extension] -->|HTTP| API
    CLI[rag-index CLI] -->|HTTP| API
    AGENT[AI Agents] -->|HTTP| API

    API[RAG API] -->|embed| OL[Ollama]
    API -->|vectors + chunks + entities + queue| PG[Postgres + pgvector]
    API -->|large files| MINIO[MinIO / S3<br/>opt-in]

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
— (no raw storage)             →  MinIO (opt-in, large files)
Ollama (embeddings + LLM)     →  Ollama (unchanged)
```

### Docker Compose

```yaml
# Core (always)
postgres:    # Postgres 17 + pgvector
ollama:      # Unchanged

# Optional profiles
minio:       # --profile storage
worker:      # --profile enrichment (unchanged role)
```

### Environment variables

```
# Replaces: QDRANT_URL, QDRANT_COLLECTION, VECTOR_SIZE, DISTANCE,
#           NEO4J_URL, NEO4J_USER, NEO4J_PASSWORD, REDIS_URL
DATABASE_URL=postgresql://rag:rag@localhost:5432/ragstack

# Unchanged
ENRICHMENT_ENABLED=false

# New (optional)
BLOB_STORE_URL=http://localhost:9000
BLOB_STORE_ACCESS_KEY=minioadmin
BLOB_STORE_SECRET_KEY=minioadmin
BLOB_STORE_BUCKET=rag-raw
```

---

## Database schema

```sql
-- Extensions
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Documents (new first-class concept, currently implicit via baseId)
CREATE TABLE documents (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source        TEXT NOT NULL,
    doc_type      TEXT,
    collection    TEXT NOT NULL DEFAULT 'docs',
    repo_id       TEXT,
    repo_url      TEXT,
    path          TEXT,
    lang          TEXT,
    title         TEXT,
    raw_key       TEXT,
    raw_bytes     BIGINT,
    mime_type     TEXT,
    created_at    TIMESTAMPTZ DEFAULT now(),
    updated_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_documents_source ON documents (source);
CREATE INDEX idx_documents_collection ON documents (collection);
CREATE INDEX idx_documents_repo_id ON documents (repo_id);

-- Chunks (replaces Qdrant points)
CREATE TABLE chunks (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id         UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    chunk_index         INT NOT NULL,
    text                TEXT NOT NULL,
    embedding           vector(768),
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

-- Document-entity mentions (replaces Neo4j MENTIONS edges)
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
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','processing','completed','failed','dead')),
    payload         JSONB NOT NULL,
    attempt         INT DEFAULT 1,
    max_attempts    INT DEFAULT 3,
    run_after       TIMESTAMPTZ DEFAULT now(),
    started_at      TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,
    error           TEXT,
    created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_task_queue_dequeue
    ON task_queue (queue, run_after)
    WHERE status = 'pending';
```

### Operation mappings

| Current | Postgres |
|---------|----------|
| `qdrant.upsert(points)` | `INSERT INTO chunks ... ON CONFLICT DO UPDATE` |
| `qdrant.search(vector, limit, filter)` | `SELECT ... ORDER BY embedding <=> $1 LIMIT $n` |
| `qdrant.scroll(filter)` | `SELECT ... WHERE ... LIMIT $n OFFSET $o` |
| `qdrant.set_payload()` | `UPDATE chunks SET tier2_meta = $1 WHERE id = $2` |
| Neo4j `MERGE Entity` | `INSERT INTO entities ... ON CONFLICT (name) DO UPDATE` |
| Neo4j graph traversal (1-2 hops) | JOIN or recursive CTE |
| Redis `LPUSH` (enqueue) | `INSERT INTO task_queue` |
| Redis `BRPOP` (dequeue) | `FOR UPDATE SKIP LOCKED` (polled) |
| Redis `LLEN` | `SELECT count(*) FROM task_queue WHERE status = 'pending'` |

### Worker dequeue pattern

```sql
WITH next AS (
    SELECT id FROM task_queue
    WHERE queue = 'enrichment' AND status = 'pending' AND run_after <= now()
    ORDER BY created_at
    LIMIT 1
    FOR UPDATE SKIP LOCKED
)
UPDATE task_queue SET status = 'processing', started_at = now()
FROM next WHERE task_queue.id = next.id
RETURNING *;
```

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
- `api/src/services/enrichment.ts` — Status from chunks table, queue from task_queue

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
- `docker-compose.yml` — Replace qdrant + redis + neo4j with postgres + optional minio
- `.env.example` — DATABASE_URL replaces 6+ env vars
- `chart/templates/` — Delete qdrant/redis/neo4j YAMLs, add postgres-*.yaml
- `chart/values.yaml` — Postgres config block replaces three

### Dependency changes

| Component | Remove | Add |
|-----------|--------|-----|
| API (npm) | `@qdrant/js-client-rest`, `redis`, `neo4j-driver` | `pg`, `pgvector` |
| Worker (pip) | `qdrant-client`, `redis`, `neo4j` | `asyncpg`, `pgvector` |

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

This migration must land **before** Chat Phase A (#45) and Extension Phase 3 (#42).

---

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Single DB | Postgres 17 + pgvector | One backup, one connection, one service |
| Migration style | Clean break | No adapter complexity, old code deleted |
| Vector search | pgvector HNSW, cosine distance | Handles millions of 768d vectors |
| Graph storage | Relational tables + JOINs | Simple entity model, 1-2 hop lookups |
| Task queue | SKIP LOCKED polling | Atomic dequeue, no new dependency |
| Blob storage | MinIO opt-in | S3-compatible, local-first, large files only |
| Documents table | New first-class concept | Enables browse, raw file tracking, document metadata |
| DB client (API) | `pg` + `pgvector` | Lightweight, no ORM |
| DB client (Worker) | `asyncpg` + `pgvector` | Async-native, works with asyncio loop |
| Schema migrations | SQL files in `api/migrations/` | Version-controlled, run on startup |
| Graph always on | Remove `isGraphEnabled()` gate | Graph is just tables — no reason to gate |
| Enrichment optional | Keep `ENRICHMENT_ENABLED` | Controls task enqueue, not table existence |
