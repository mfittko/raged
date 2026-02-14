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

---

### POST /query (with graph expansion)

Embed a query, search for similar chunks, and optionally expand related entities via the knowledge graph.

**Request:**
```json
{
  "collection": "docs",
  "query": "authentication flow",
  "topK": 5,
  "graphExpand": true
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `graphExpand` | boolean | No | Enable graph-based entity expansion (requires Neo4j) |

**Response (with graph expansion):**
```json
{
  "ok": true,
  "results": [ /* same as above */ ],
  "graph": {
    "entities": [
      { "name": "AuthService", "type": "class" },
      { "name": "JWT", "type": "library" }
    ],
    "relationships": []
  }
}
```

**Behavior:**
- When `graphExpand: true`, extracts entities from `tier2`/`tier3` metadata in results
- Expands entities via Neo4j graph traversal (2 hops by default)
- Returns expanded entity set in `graph` field
- Gracefully returns no graph data if Neo4j is not configured

---

### GET /enrichment/status/:baseId

Get enrichment status for all chunks belonging to a document.

**Request:**
```
GET /enrichment/status/my-repo:src/auth.ts?collection=docs
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `baseId` | string (path) | Yes | Base document ID |
| `collection` | string (query) | No | Collection name (default: `docs`) |

**Response:**
```json
{
  "status": "enriched",
  "chunks": {
    "total": 3,
    "enriched": 3,
    "pending": 0,
    "processing": 0,
    "failed": 0,
    "none": 0
  },
  "extractedAt": "2026-02-14T10:05:00Z",
  "metadata": {
    "tier2": { "entities": [...], "keywords": [...], "language": "en" },
    "tier3": { "summary": "...", "entities": [...] }
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `status` | string | Overall status: `enriched`, `pending`, `processing`, `failed`, `none`, or `mixed` |
| `chunks.total` | number | Total number of chunks for this document |
| `chunks.enriched` | number | Chunks with completed enrichment |
| `chunks.pending` | number | Chunks waiting for enrichment |
| `chunks.processing` | number | Chunks currently being enriched |
| `chunks.failed` | number | Chunks with failed enrichment |
| `chunks.none` | number | Chunks with no enrichment attempted |
| `extractedAt` | string | ISO 8601 timestamp of latest enrichment |
| `metadata.tier2` | object | Tier-2 metadata (NLP: entities, keywords, language) |
| `metadata.tier3` | object | Tier-3 metadata (LLM: summary, entities, etc.) |

**Error Responses:**
- `404` - No chunks found for the given baseId

---

### GET /enrichment/stats

Get system-wide enrichment statistics.

**Response:**
```json
{
  "queue": {
    "pending": 10,
    "processing": 2,
    "deadLetter": 0
  },
  "totals": {
    "enriched": 150,
    "failed": 2,
    "pending": 10,
    "processing": 2,
    "none": 36
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `queue.pending` | number | Tasks in Redis pending queue |
| `queue.processing` | number | Tasks currently being processed |
| `queue.deadLetter` | number | Failed tasks in dead-letter queue |
| `totals.enriched` | number | Total enriched chunks in Qdrant |
| `totals.failed` | number | Total failed chunks |
| `totals.pending` | number | Total pending chunks |
| `totals.processing` | number | Total processing chunks |
| `totals.none` | number | Total chunks with no enrichment |

**Behavior:**
- Returns zero counts when enrichment is disabled (no Redis/worker)
- Scans Qdrant collection to count chunks by `enrichmentStatus`

---

### POST /enrichment/enqueue

Manually trigger enrichment for existing chunks.

**Request:**
```json
{
  "collection": "docs",
  "force": false
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `collection` | string | No | Collection to scan (default: `docs`) |
| `force` | boolean | No | Re-enqueue already-enriched items (default: `false`) |

**Response:**
```json
{
  "ok": true,
  "enqueued": 25
}
```

| Field | Type | Description |
|-------|------|-------------|
| `ok` | boolean | Success indicator |
| `enqueued` | number | Number of tasks enqueued |

**Behavior:**
- Scans collection for chunks with `enrichmentStatus` != `"enriched"` (unless `force: true`)
- Creates enrichment tasks with correct `totalChunks` per baseId
- Enqueues tasks to Redis `enrichment:pending` queue
- Returns 0 when enrichment is disabled

---

### GET /graph/entity/:name

Get entity details and connections from the knowledge graph.

**Request:**
```
GET /graph/entity/AuthService
```

**Response:**
```json
{
  "entity": {
    "name": "AuthService",
    "type": "class",
    "description": "Handles user authentication"
  },
  "connections": [
    { "entity": "JWT", "relationship": "uses", "direction": "outgoing" },
    { "entity": "UserService", "relationship": "relates_to", "direction": "incoming" }
  ],
  "documents": [
    { "id": "my-repo:src/auth.ts:0" },
    { "id": "my-repo:src/auth.ts:1" }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `entity` | object | The requested entity's metadata |
| `connections` | array | Related entities from the graph |
| `connections[].entity` | string | Name of the connected entity |
| `connections[].relationship` | string | Type of relationship |
| `connections[].direction` | string | Relationship direction: `"outgoing"` or `"incoming"` |
| `documents` | array | Documents that mention this entity |

**Error Responses:**
- `503` - Graph functionality is not enabled (Neo4j not configured)
- `404` - Entity not found in the graph

