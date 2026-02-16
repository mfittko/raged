# API Reference

HTTP API for the raged RAG service.

**Base URL:** `http://localhost:8080` (local) or your Ingress hostname (remote)

## Authentication

When `RAGED_API_TOKEN` is set on the server, all endpoints except `/healthz` require a bearer token:

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

Chunk, embed, and store text items or fetch content from URLs in a collection.

**Request (text-based):**
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

**Request (URL-based):**
```json
{
  "collection": "docs",
  "items": [
    {
      "url": "https://example.com/article",
      "source": "Example Article"
    }
  ]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `collection` | string | No | Collection name (default: `docs`) |
| `items` | array | Yes | Items to ingest (max 1000) |
| `items[].id` | string | No | Base ID for chunks (auto-generated UUID if omitted) |
| `items[].text` | string | Conditional* | Full text content to chunk and embed |
| `items[].url` | string | Conditional* | URL to fetch content from (HTTP/HTTPS only) |
| `items[].source` | string | Conditional** | Source identifier (URL, path, etc.) |
| `items[].metadata` | object | No | Additional metadata stored with each chunk |
| `items[].docType` | string | No | Document type (e.g., `code`, `text`, `pdf`, `image`, `slack`, `article`) for type-specific extraction |
| `enrich` | boolean | No | Enable async enrichment (default: `true` when enrichment is enabled) |

\* Either `text` or `url` must be provided. If `url` is provided without `text`, the API fetches and extracts content server-side.

\*\* `source` is required if `text` is provided without `url`. If `url` is provided, `source` defaults to a normalized form of the resolved URL: the `origin` and `pathname` of the final URL after redirects (query string and fragment are not included).

**Response (success):**
```json
{
  "ok": true,
  "upserted": 12,
  "fetched": 1
}
```

**Response (with errors):**
```json
{
  "ok": true,
  "upserted": 8,
  "fetched": 1,
  "errors": [
    {
      "url": "https://example.com/private",
      "status": null,
      "reason": "ssrf_blocked"
    }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `ok` | boolean | Success indicator |
| `upserted` | number | Total chunks upserted (items x chunks per item) |
| `fetched` | number | Number of URLs successfully fetched (omitted if 0) |
| `errors` | array | Per-item errors (omitted if none) |
| `errors[].url` | string | URL that failed |
| `errors[].status` | number\|null | HTTP status code (null for non-HTTP errors) |
| `errors[].reason` | string | Error reason |

**Behavior:**
1. Creates the collection if it doesn't exist (768d vectors, cosine distance)
2. For URL items: Fetches content with SSRF protection, extracts text based on content type
3. Auto-detects document type if `docType` not provided
4. Runs tier-1 metadata extraction (heuristic/AST/EXIF based on type)
5. Splits each item's text into chunks (~1800 characters, split on line boundaries)
6. Embeds each chunk via Ollama
7. Upserts all chunks into Postgres with metadata: `{ text, source, chunkIndex, enrichmentStatus, ...metadata }`
8. If `enrich: true` and enrichment is enabled, creates async enrichment task in Postgres
9. Chunk IDs follow the pattern `<baseId>:<chunkIndex>`

**URL Ingestion:**
- Supports HTML (Readability extraction), PDF (pdf-parse), plain text, markdown, JSON
- SSRF protection blocks private IPs, DNS rebinding attacks
- Partial success: successfully fetched items are ingested, failures returned in `errors`
- Maximum of 50 items with a `url` field per request; requests with more than 50 URLs are rejected with HTTP 400
- Fetch metadata (resolvedUrl, contentType, fetchStatus) added to chunk payloads

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
| `collection` | string | No | Collection name (default: `docs`) |
| `query` | string | Yes | Search query text |
| `topK` | number | No | Number of results (default: `8`) |
| `filter` | object | No | Filter object |

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
| `graphExpand` | boolean | No | Enable graph-based entity expansion (requires enrichment enabled) |

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
- Expands entities via Postgres relationship traversal (2 hops by default)
- Returns expanded entity set in `graph` field
- Gracefully returns no graph data if enrichment is not configured

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
| `queue.pending` | number | Tasks in Postgres task queue |
| `queue.processing` | number | Tasks currently being processed |
| `queue.deadLetter` | number | Failed tasks count |
| `totals.enriched` | number | Total enriched chunks |
| `totals.failed` | number | Total failed chunks |
| `totals.pending` | number | Total pending chunks |
| `totals.processing` | number | Total processing chunks |
| `totals.none` | number | Total chunks with no enrichment |

**Behavior:**
- Returns zero counts when enrichment is disabled (no worker)
- Scans collection to count chunks by `enrichmentStatus`

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
- Inserts tasks to Postgres `enrichment_tasks` table
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
- `503` - Graph functionality is not enabled (entity relationships require enrichment to be enabled)
- `404` - Entity not found in the graph

