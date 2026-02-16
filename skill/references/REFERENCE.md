# raged API Reference

Detailed reference for advanced usage. The agent loads this on demand for complex scenarios.

## Endpoints

### GET /healthz

No authentication required.

**Response:** `{"ok": true}`

### POST /ingest

Chunks text, embeds via Ollama, upserts to Qdrant.

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
Each chunk becomes a separate Qdrant point with ID `<baseId>:<chunkIndex>`.

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
    "must": [
      {"key": "repoId", "match": {"value": "my-repo"}},
      {"key": "lang", "match": {"value": "ts"}},
      {"key": "path", "match": {"text": "src/"}}
    ]
  }
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
  ]
}
```

## Infrastructure

| Service | Default URL | Purpose |
|---------|------------|---------|
| raged API | `http://localhost:8080` | HTTP gateway |
| Qdrant | `http://localhost:6333` | Vector database |
| Ollama | `http://localhost:11434` | Embedding model |

**Embedding model:** `nomic-embed-text` (768 dimensions, cosine distance)

## Environment Variables (API server)

| Variable | Default | Purpose |
|----------|---------|---------|
| `QDRANT_URL` | `http://qdrant:6333` | Qdrant connection |
| `OLLAMA_URL` | `http://ollama:11434` | Ollama connection |
| `QDRANT_COLLECTION` | `docs` | Default collection |
| `VECTOR_SIZE` | `768` | Embedding dimensions |
| `DISTANCE` | `Cosine` | Similarity metric |
| `EMBED_MODEL` | `nomic-embed-text` | Ollama model name |
| `PORT` | `8080` | API listen port |
| `RAG_API_TOKEN` | _(empty)_ | Bearer token (empty = auth disabled) |
