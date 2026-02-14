# Architecture

rag-stack is a multi-component system for RAG with enrichment and knowledge graph capabilities.

## Component Diagram

```mermaid
graph TD
    CLI[rag-index CLI] -->|"POST /ingest"| API[RAG API<br/>:8080]
    CLI -->|"POST /query"| API
    CLI -->|"POST /enrichment/enqueue"| API
    CLI -->|"GET /graph/entity/:name"| API
    
    API -->|"POST /api/embeddings"| OL[Ollama<br/>:11434]
    API -->|"upsert / search"| QD[Qdrant<br/>:6333]
    API -->|"enqueue task"| RD[Redis Queue<br/>:6379]
    API -->|"query entities"| NEO[Neo4j Graph<br/>:7687]
    
    WK[Enrichment Worker] -->|"BRPOP task"| RD
    WK -->|"read/update payload"| QD
    WK -->|"NLP + LLM extraction"| OL
    WK -->|"upsert entities"| NEO

    subgraph Storage
        QD
        OL
        RD
        NEO
    end

    style API fill:#e1f5fe
    style QD fill:#f3e5f5
    style OL fill:#e8f5e9
    style RD fill:#fff9c4
    style NEO fill:#fce4ec
    style WK fill:#e0f2f1
```

## Components

### RAG API (Fastify)

Stateless HTTP service exposing core endpoints:

**Ingestion & Query:**
- `POST /ingest` — Receives any text items (code, docs, PDFs, images, etc.), runs tier-1 extraction, chunks, embeds via Ollama, upserts vectors into Qdrant, optionally enqueues enrichment
- `POST /query` — Embeds the query text, performs similarity search in Qdrant, optionally expands entities via Neo4j, returns ranked results

**Enrichment:**
- `GET /enrichment/status/:baseId` — Get enrichment status for a document
- `GET /enrichment/stats` — System-wide enrichment statistics
- `POST /enrichment/enqueue` — Manually trigger enrichment for existing chunks

**Knowledge Graph:**
- `GET /graph/entity/:name` — Lookup entity details and connections in Neo4j

**Health:**
- `GET /healthz` — Always unauthenticated, returns `{ ok: true }`

### Qdrant (Vector DB)

Stores embedding vectors with metadata payloads. Each collection holds vectors of a fixed dimension (768 for nomic-embed-text) using cosine distance.

Metadata payload per point:
- `text` — the original chunk text
- `source` — source URL or path
- `chunkIndex` — position of chunk within the original document
- `enrichmentStatus` — `none`, `pending`, `processing`, `enriched`, or `failed`
- `tier1`, `tier2`, `tier3` — metadata from extraction tiers (when enriched)
- `repoId`, `repoUrl`, `path`, `lang`, `bytes` — indexing metadata (present when ingested via CLI)

### Ollama (Embedding Runtime)

Runs the `nomic-embed-text` model locally for embeddings, and LLM models (llama3, llava) for tier-3 extraction. The API calls Ollama's `/api/embeddings` endpoint for each text chunk. Produces 768-dimensional vectors.

### Redis (Task Queue)

Holds enrichment tasks in two queues:
- `enrichment:pending` — tasks waiting for processing
- `enrichment:dead-letter` — failed tasks after max retries

### Neo4j (Knowledge Graph)

Stores entities and relationships extracted from documents. Supports graph traversal for hybrid vector+graph retrieval.

Node types: Entity (with properties: name, type, description)
Relationship types: Configurable based on extraction (e.g., `uses`, `relates_to`, `mentions`)

### Enrichment Worker (Python)

Async background service that:
1. Pulls enrichment tasks from Redis (`BRPOP`)
2. Runs tier-2 extraction (spaCy NER, TextRank keywords, language detection)
3. Runs tier-3 extraction (LLM-based summaries and entity extraction via pluggable provider)
4. Updates Qdrant chunk payloads with `tier2`/`tier3` metadata
5. Upserts entities and relationships to Neo4j
6. Moves failed tasks to dead-letter queue after max retries

### CLI (rag-index)

Command-line tool with five commands:
- `index` — Clone Git repo and index files
- `query` — Search for similar chunks
- `ingest` — Ingest arbitrary files (PDFs, images, text)
- `enrich` — Trigger/monitor enrichment tasks
- `graph` — Query knowledge graph entities

## Enriched Index Data Flow

```mermaid
sequenceDiagram
    participant U as User / Agent
    participant C as CLI
    participant A as RAG API
    participant O as Ollama
    participant Q as Qdrant
    participant R as Redis
    participant W as Worker
    participant N as Neo4j

    U->>C: rag-index index --repo <url>
    C->>C: git clone (shallow)
    C->>C: Scan files, filter, read text
    loop Batch of 50 files
        C->>A: POST /ingest { items, enrich: true }
        A->>A: Detect doc type, tier-1 extraction
        A->>A: chunkText() per item
        loop Per chunk
            A->>O: POST /api/embeddings
            O-->>A: 768d vector
        end
        A->>Q: upsert(points with enrichmentStatus: pending)
        Q-->>A: OK
        A->>R: LPUSH enrichment:pending
        A-->>C: { ok, upserted }
    end
    C-->>U: Done. repoId=<id>
    
    W->>R: BRPOP enrichment:pending
    R-->>W: Task { baseId, collection, totalChunks }
    W->>Q: Get chunks by baseId
    Q-->>W: Chunk payloads
    W->>W: Tier-2: spaCy NER, keywords, lang
    W->>O: Tier-3: LLM extraction
    O-->>W: Summary, entities
    W->>Q: Update payloads with tier2/tier3
    W->>N: Upsert entities + relationships
    N-->>W: OK
```

## Index Data Flow

```mermaid
sequenceDiagram
    participant U as User / Agent
    participant C as CLI
    participant A as RAG API
    participant O as Ollama
    participant Q as Qdrant

    U->>C: rag-index index --repo <url>
    C->>C: git clone (shallow)
    C->>C: Scan files, filter, read text
    loop Batch of 50 files
        C->>A: POST /ingest { items }
        A->>A: chunkText() per item
        loop Per chunk
            A->>O: POST /api/embeddings
            O-->>A: 768d vector
        end
        A->>Q: upsert(points)
        Q-->>A: OK
        A-->>C: { ok, upserted }
    end
    C-->>U: Done. repoId=<id>
```

## Query Data Flow

```mermaid
sequenceDiagram
    participant U as User / Agent
    participant C as CLI
    participant A as RAG API
    participant O as Ollama
    participant Q as Qdrant

    U->>C: rag-index query --q "auth flow"
    C->>A: POST /query { query, topK }
    A->>O: POST /api/embeddings { prompt }
    O-->>A: 768d vector
    A->>Q: search(vector, limit, filter)
    Q-->>A: Ranked results
    A-->>C: { results: [...] }
    C-->>U: Display results
```

## Security Model

```mermaid
flowchart LR
    R[Request] --> H{Has<br/>Authorization<br/>header?}
    H -->|No| R401[401 Unauthorized]
    H -->|Yes| P{Bearer prefix?}
    P -->|No| R401
    P -->|Yes| T{Timing-safe<br/>compare with<br/>RAG_API_TOKEN}
    T -->|Mismatch| R401
    T -->|Match| OK[Request proceeds]

    HZ[GET /healthz] --> OK

    style R401 fill:#ffcdd2
    style OK fill:#c8e6c9
```

- Token auth is optional (disabled when `RAG_API_TOKEN` is empty)
- `/healthz` always bypasses auth
- Token comparison uses timing-safe algorithm to prevent timing attacks
- Tokens are provided via environment variable, never hardcoded
