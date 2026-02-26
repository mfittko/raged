# raged API Reference

Detailed reference for advanced usage. The agent loads this on demand for complex scenarios.

## Endpoints

### GET /healthz

No authentication required.

**Response:** `{"ok": true}`

### POST /ingest

Chunks text, embeds via Ollama, upserts to Postgres with pgvector.

**Headers:**
- `Content-Type: application/json`
- `Authorization: Bearer <token>` (if auth enabled)

**Body:**
```json
{
  "collection": "docs",
  "items": [
    {
      "id": "base-id",
      "text": "full text content",
      "source": "https://example.com/file.ts",
      "metadata": {"key": "value"}
    }
  ]
}
```

**Chunking:** Text is split into ~1800-character chunks on line boundaries.
Each chunk becomes a separate record with ID `<baseId>:<chunkIndex>`.

**Stored payload per chunk:**
```json
{
  "text": "chunk content",
  "source": "original source",
  "chunkIndex": 0,
  "repoId": "from metadata",
  "path": "from metadata",
  "lang": "from metadata"
}
```

**Response:** `{"ok": true, "upserted": 12}`

### POST /query

Embeds query text, performs vector similarity search.

**Headers:**
- `Content-Type: application/json`
- `Authorization: Bearer <token>` (if auth enabled)

**Body:**
```json
{
  "collection": "docs",
  "query": "search text",
  "topK": 8,
  "filter": {
    "repoId": "my-repo",
    "lang": "ts",
    "path": "src/"
  },
  "strategy": "semantic"
}
```

**Response:**
```json
{
  "ok": true,
  "results": [
    {
      "id": "my-repo:src/auth.ts:0",
      "score": 0.87,
      "source": "https://github.com/org/repo#src/auth.ts",
      "text": "chunk content...",
      "payload": {}
    }
  ],
  "routing": {
    "strategy": "semantic",
    "method": "rule",
    "confidence": 0.9,
    "durationMs": 12
  }
}
```

> **Note:** When the router selects `metadata` strategy, `score` is always `1.0`. Result items may include a `text` field, but clients must not rely on its absence.

## Infrastructure

| Service | Default URL | Purpose |
|---------|------------|---------|
| raged API | `http://localhost:8080` | HTTP gateway |
| Postgres | `localhost:5432` | Vector database (pgvector) |
| Ollama | `http://localhost:11434` | Embedding model |

**Embedding model:** `nomic-embed-text` (768 dimensions, cosine distance)

## Environment Variables (API server)

| Variable | Default | Purpose |
|----------|---------|---------|
| `DATABASE_URL` | _(required)_ | Postgres connection string (e.g. `postgresql://raged:raged@localhost:5432/raged`) |
| `OLLAMA_URL` | `http://ollama:11434` | Ollama connection |
| `VECTOR_SIZE` | `768` | Embedding dimensions |
| `EMBED_MODEL` | `nomic-embed-text` | Ollama model name |
| `PORT` | `8080` | API listen port |
| `RAGED_API_TOKEN` | _(empty)_ | Bearer token (empty = auth disabled) |
