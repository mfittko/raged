# Architecture

rag-stack is a four-component system: CLI, API, vector database, and embedding runtime.

## Component Diagram

```mermaid
graph TD
    CLI[rag-index CLI] -->|"POST /ingest"| API[RAG API<br/>:8080]
    CLI -->|"POST /query"| API
    API -->|"POST /api/embeddings"| OL[Ollama<br/>:11434]
    API -->|"upsert / search"| QD[Qdrant<br/>:6333]

    subgraph Storage
        QD
        OL
    end

    style API fill:#e1f5fe
    style QD fill:#f3e5f5
    style OL fill:#e8f5e9
```

## Components

### RAG API (Fastify)

Stateless HTTP service exposing two core endpoints:

- `POST /ingest` — Receives text items, chunks them, embeds each chunk via Ollama, upserts vectors into Qdrant
- `POST /query` — Embeds the query text, performs similarity search in Qdrant, returns ranked results
- `GET /healthz` — Always unauthenticated, returns `{ ok: true }`

### Qdrant (Vector DB)

Stores embedding vectors with metadata payloads. Each collection holds vectors of a fixed dimension (768 for nomic-embed-text) using cosine distance.

Metadata payload per point:
- `text` — the original chunk text
- `source` — source URL or path
- `chunkIndex` — position of chunk within the original document
- `repoId`, `repoUrl`, `path`, `lang`, `bytes` — indexing metadata

### Ollama (Embedding Runtime)

Runs the `nomic-embed-text` model locally. The API calls Ollama's `/api/embeddings` endpoint for each text chunk. Produces 768-dimensional vectors.

### CLI (rag-index)

Command-line tool for indexing and querying. Clones Git repos to a temp directory, scans for text files, sends them in batches to the API's `/ingest` endpoint.

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
