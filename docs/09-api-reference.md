# API Reference

HTTP API for the rag-stack RAG service.

**Base URL:** `http://localhost:8080` (local) or your Ingress hostname (remote)

## Authentication

When `RAG_API_TOKEN` is set on the server, all endpoints except `/healthz` require a bearer token:

```
Authorization: Bearer <token>
```

## Endpoints

### GET /healthz

Health check. Always unauthenticated.

**Response:**
```json
{ "ok": true }
```

---

### POST /ingest

Chunk, embed, and store text items in a Qdrant collection.

**Request:**
```json
{
  "collection": "docs",
  "items": [
    {
      "id": "my-repo:src/auth.ts",
      "text": "import { FastifyInstance } from 'fastify';\n...",
      "source": "https://github.com/org/repo#src/auth.ts",
      "metadata": {
        "repoId": "my-repo",
        "path": "src/auth.ts",
        "lang": "ts",
        "bytes": 1234
      }
    }
  ]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `collection` | string | No | Qdrant collection name (default: `docs`) |
| `items` | array | Yes | Items to ingest |
| `items[].id` | string | No | Base ID for chunks (auto-generated UUID if omitted) |
| `items[].text` | string | Yes | Full text content to chunk and embed |
| `items[].source` | string | Yes | Source identifier (URL, path, etc.) |
| `items[].metadata` | object | No | Additional metadata stored with each chunk |

**Response:**
```json
{
  "ok": true,
  "upserted": 12
}
```

| Field | Type | Description |
|-------|------|-------------|
| `ok` | boolean | Success indicator |
| `upserted` | number | Total chunks upserted (items x chunks per item) |

**Behavior:**
1. Creates the collection if it doesn't exist (768d vectors, cosine distance)
2. Splits each item's text into chunks (~1800 characters, split on line boundaries)
3. Embeds each chunk via Ollama
4. Upserts all chunks into Qdrant with payload: `{ text, source, chunkIndex, ...metadata }`
5. Chunk IDs follow the pattern `<baseId>:<chunkIndex>`

---

### POST /query

Embed a query and search for similar chunks.

**Request:**
```json
{
  "collection": "docs",
  "query": "authentication flow",
  "topK": 5,
  "filter": {
    "must": [
      { "key": "repoId", "match": { "value": "my-repo" } },
      { "key": "lang", "match": { "value": "ts" } }
    ]
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `collection` | string | No | Qdrant collection name (default: `docs`) |
| `query` | string | Yes | Search query text |
| `topK` | number | No | Number of results (default: `8`) |
| `filter` | object | No | Qdrant filter object |

**Response:**
```json
{
  "ok": true,
  "results": [
    {
      "id": "my-repo:src/auth.ts:0",
      "score": 0.87,
      "source": "https://github.com/org/repo#src/auth.ts",
      "text": "import { FastifyInstance } from 'fastify';\n...",
      "payload": {
        "text": "...",
        "source": "...",
        "chunkIndex": 0,
        "repoId": "my-repo",
        "lang": "ts"
      }
    }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `results[].id` | string | Chunk ID (`<baseId>:<chunkIndex>`) |
| `results[].score` | number | Cosine similarity score (0-1, higher = more similar) |
| `results[].source` | string | Source identifier |
| `results[].text` | string | Chunk text content |
| `results[].payload` | object | Full metadata payload |

**Filter Examples:**

Filter by repository:
```json
{ "must": [{ "key": "repoId", "match": { "value": "my-repo" } }] }
```

Filter by language:
```json
{ "must": [{ "key": "lang", "match": { "value": "ts" } }] }
```

Filter by path prefix:
```json
{ "must": [{ "key": "path", "match": { "text": "src/api/" } }] }
```

Combine filters:
```json
{
  "must": [
    { "key": "repoId", "match": { "value": "my-repo" } },
    { "key": "lang", "match": { "value": "ts" } },
    { "key": "path", "match": { "text": "src/" } }
  ]
}
```
