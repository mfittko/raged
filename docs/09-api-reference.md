# API Reference

HTTP API for the raged service.

**Base URL:** `http://localhost:8080` (local) or your Ingress hostname (remote)

## Authentication

When `RAGED_API_TOKEN` is set, all endpoints except `GET /healthz` require:

```
Authorization: Bearer <token>
```

## Endpoints

### GET /healthz

Liveness endpoint. Always unauthenticated.

```json
{ "ok": true }
```

---

### POST /ingest

Ingest items by text or URL fetch.

**Request:**
```json
{
  "collection": "docs",
  "enrich": true,
  "items": [
    {
      "id": "my-repo:src/auth.ts",
      "text": "...",
      "source": "https://github.com/org/repo/blob/main/src/auth.ts",
      "docType": "code",
      "metadata": {
        "repoId": "my-repo",
        "path": "src/auth.ts",
        "lang": "ts"
      }
    }
  ]
}
```

**URL-based item:**
```json
{
  "items": [
    {
      "url": "https://example.com/article"
    }
  ]
}
```

- `collection` defaults to `docs`
- `items` is required (`1..1000`)
- Each item must provide `text` or `url`
- If `text` is used without `url`, `source` is required
- URL fetch mode supports partial success and returns `errors[]` per failed URL

**Response (example):**
```json
{
  "ok": true,
  "upserted": 12,
  "fetched": 1
}
```

---

### POST /query

Semantic search over chunks with multi-strategy routing.

**Request:**
```json
{
  "collection": "docs",
  "query": "authentication flow",
  "topK": 8,
  "minScore": 0.5,
  "filter": {
    "repoId": "my-repo",
    "lang": "ts",
    "path": "src/"
  },
  "strategy": "graph"
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `collection` | string | `docs` | Collection to search |
| `query` | string | _(none)_ | Natural-language query text (required for semantic, graph, hybrid) |
| `topK` | number | `8` | Number of results (`1..100`) |
| `minScore` | number | _(auto)_ | Minimum cosine similarity (`0..1`); auto-derived from query term count when omitted |
| `filter` | object | _(none)_ | Allowed keys mapped to chunk columns (`chunkIndex`, `docType`, `repoId`, `repoUrl`, `path`, `lang`, `itemUrl`, `enrichmentStatus`) |
| `graphExpand` | boolean | `false` | Deprecated. Use `strategy: "graph"` instead |
| `strategy` | enum | _(auto)_ | Force a strategy: `semantic`, `metadata`, `graph`, `hybrid` |

**Response (example):**
```json
{
  "ok": true,
  "results": [
    {
      "id": "my-repo:src/auth.ts:0",
      "score": 0.82,
      "source": "https://github.com/org/repo/blob/main/src/auth.ts",
      "text": "...",
      "payload": {
        "chunkIndex": 0,
        "baseId": "my-repo:src/auth.ts",
        "docType": "code",
        "repoId": "my-repo",
        "path": "src/auth.ts",
        "lang": "ts",
        "tier1Meta": {},
        "tier2Meta": null,
        "tier3Meta": null,
        "docSummary": null,
        "docSummaryShort": null,
        "docSummaryMedium": null,
        "docSummaryLong": null,
        "payloadChecksum": "..."
      }
    }
  ],
  "graph": {
    "entities": [
      { "name": "AuthService", "type": "class", "depth": 0, "isSeed": true }
    ],
    "relationships": [
      { "source": "AuthService", "target": "JWT", "type": "uses" }
    ],
    "paths": [],
    "documents": [
      { "documentId": "abc123", "source": "src/auth.ts", "entityName": "AuthService", "mentionCount": 3 }
    ],
    "meta": {
      "entityCount": 1,
      "capped": false,
      "timedOut": false,
      "warnings": [],
      "seedEntities": ["abc123"],
      "seedSource": "results",
      "maxDepthUsed": 2,
      "entityCap": 50,
      "timeLimitMs": 3000
    }
  },
  "routing": {
    "strategy": "graph",
    "method": "explicit",
    "confidence": 1.0,
    "durationMs": 12
  }
}
```

#### Response fields

**Top-level envelope:**

| Field | Type | Presence | Description |
|-------|------|----------|-------------|
| `ok` | `true` | always | Success indicator |
| `results` | `QueryResultItem[]` | always | Ranked result items |
| `graph` | `GraphResult` | when strategy is `graph` or `hybrid`, or when `graphExpand` / `graph` params are provided | Entity graph data |
| `routing` | `RoutingDecision` | always | How the strategy was selected |

**`results[].` per-item fields:**

| Field | Type | Description |
|-------|------|-------------|
| `id` | string/number | `"baseId:chunkIndex"` or arbitrary string |
| `score` | number (0–1) | Cosine similarity; `1.0` for metadata-only results |
| `source` | string? | Source URL or path |
| `text` | string? | Chunk text; absent for metadata-only results |
| `payload` | object? | Enrichment metadata (unchanged shape) |

**`routing.` fields:**

| Field | Type | Description |
|-------|------|-------------|
| `strategy` | enum | `metadata \| graph \| semantic \| hybrid` |
| `method` | enum | `explicit \| rule \| llm \| rule_fallback \| default` |
| `confidence` | 0–1 | Classification confidence |
| `rule` | string? | Matched rule name |
| `durationMs` | number | Router wall-clock time (ms) |
| `inferredFilter` | boolean? | `true` when LLM filter extraction inferred and applied a FilterDSL from the query text |

**`graph.meta.` fields:**

| Field | Type | Description |
|-------|------|-------------|
| `entityCount` | number | Total entities in the traversal result |
| `capped` | boolean | Whether the entity cap was reached |
| `timedOut` | boolean | Whether traversal hit the time limit |
| `warnings` | string[] | Any non-fatal warnings from graph traversal |
| `seedEntities` | string[] | IDs of the seed entities used to start traversal |
| `seedSource` | string | How seeds were chosen (`results` or `explicit`) |
| `maxDepthUsed` | number | Maximum graph depth actually traversed |
| `entityCap` | number | Maximum number of entities allowed in this traversal |
| `timeLimitMs` | number | Wall-clock time limit (ms) configured for this traversal |

> **Note:** Additional implementation-specific `graph.meta` fields may be returned; clients should ignore unknown keys for forward compatibility.

> **Note:** When the router selects `metadata` strategy, `score` is always `1.0`. Result items may include a `text` field (for example, containing chunk text), but clients should not rely on its absence and should not use `score` for relevance ranking in this strategy.

---

### POST /query/download-first

Runs `/query`, resolves the first result document, and returns a downloadable file.

- Uses `documents.raw_data` when present
- Falls back to blob-store by `documents.raw_key` when present
- Returns `404` when query has no result, result has no `baseId`, document not found, or no raw payload exists
- Returns `502` when blob-store retrieval fails

**Request body:** same as `/query` except `graphExpand` is not accepted.

---

### POST /query/fulltext-first

Runs `/query`, resolves the first result document, fetches all chunks for that document, and returns concatenated plain text.

- Content-Type: `text/plain; charset=utf-8`
- Returns `404` for no query results or no chunks for the selected document

**Request body:** same as `/query/download-first`.

---

### GET /collections

Returns collection-level overview.

**Response:**
```json
{
  "ok": true,
  "collections": [
    {
      "collection": "docs",
      "documentCount": 5,
      "chunkCount": 20,
      "enrichedChunkCount": 15,
      "lastSeenAt": "2026-02-20T00:00:00.000Z"
    }
  ]
}
```

---

### GET /enrichment/status/:baseId

Returns enrichment status for all chunks of one document.

**Request example:**
```
GET /enrichment/status/my-repo:src/auth.ts?collection=docs
```

**Response fields:**
- `status`: `enriched | processing | pending | failed | none | mixed`
- `chunks`: per-status counts
- `extractedAt`: latest `enriched_at` timestamp when available
- `metadata.tier2`, `metadata.tier3`: latest enriched metadata snapshot
- `metadata.error`: extracted from `tier3_meta._error` for failed status, including `chunkIndex` when present

---

### GET /enrichment/stats

Returns queue and chunk totals, optionally filtered.

**Query params:**
- `collection` (default `docs`)
- `filter` (text filter)

**Response:**
```json
{
  "queue": {
    "pending": 10,
    "processing": 2,
    "deadLetter": 1
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

Filter behavior uses full-text + ILIKE fallback. Invalid `websearch_to_tsquery` input automatically retries with ILIKE-only logic.

---

### POST /enrichment/enqueue

Enqueues enrichment tasks for chunks in a collection.

**Request:**
```json
{
  "collection": "docs",
  "force": false,
  "filter": "authentication OR auth"
}
```

- `force=false` skips already enriched chunks
- Optional `filter` scopes candidate chunks using full-text + ILIKE fallback

**Response:**
```json
{
  "ok": true,
  "enqueued": 25
}
```

---

### POST /enrichment/clear

Deletes queued enrichment tasks from `task_queue`.

**Request:**
```json
{
  "collection": "docs",
  "filter": "my-repo"
}
```

- Deletes only statuses: `pending`, `processing`, `dead`
- Does not delete completed/other statuses
- Optional `filter` supports full-text + ILIKE fallback

**Response:**
```json
{
  "ok": true,
  "cleared": 10
}
```

---

### GET /graph/entity/:name

Returns one entity with related connections and documents.

**Request example:**
```
GET /graph/entity/AuthService?limit=100
```

---

## Internal worker endpoints

Used by the enrichment worker:

- `POST /internal/tasks/claim`
- `POST /internal/tasks/:id/result`
- `POST /internal/tasks/:id/fail`
- `POST /internal/tasks/recover-stale`

These endpoints are authenticated like all non-`/healthz` routes.

---

## Environment variable reference

Key env vars that affect API behavior (see `.env.example` for full list):

| Variable | Default | Description |
|----------|---------|-------------|
| `ROUTER_LLM_ENABLED` | `true` | Enable/disable LLM strategy classification fallback |
| `ROUTER_LLM_MODEL` | `llama3` | Generative model for strategy classification |
| `ROUTER_LLM_TIMEOUT_MS` | `2000` | Timeout for strategy classifier LLM call |
| `ROUTER_LLM_CIRCUIT_BREAK_MS` | `30000` | Circuit-breaker cooldown (ms) after 5 failures |
| `ROUTER_FILTER_LLM_ENABLED` | `false` | Enable LLM filter extraction from natural language queries. Only activates when no explicit `filter` is provided, routing is ambiguous (`method: default` or `rule_fallback`), and the query is non-empty. |
| `ROUTER_FILTER_LLM_MODEL` | _(provider default)_ | Model for filter extraction (`llama3` for ollama, `gpt-4o-mini` for openai) |
| `ROUTER_FILTER_LLM_TIMEOUT_MS` | `1500` | Timeout for filter extraction LLM call |

### LLM filter extraction

When `ROUTER_FILTER_LLM_ENABLED=true`, the API will attempt to extract structured `FilterDSL` conditions from natural language queries when:

1. No explicit `filter` is provided in the request
2. Routing is ambiguous (`method: default` or `method: rule_fallback`)
3. The query is non-empty

If extraction succeeds, the inferred filter is applied to the query and `routing.inferredFilter: true` is set in the response. If extraction fails, times out, or produces invalid output, the existing behavior is unchanged — no error is returned to the caller.

**Security:** All LLM output is validated through `translateFilter` before use. Only known fields and operators are accepted; unknown output is discarded.

