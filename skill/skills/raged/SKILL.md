---
name: raged
description: >
  Store and retrieve knowledge using raged semantic search with enrichment and knowledge graph.
  Ingest any content — code, docs, PDFs, images, articles, emails, transcripts, notes — and query
  by natural language. Supports async metadata extraction, entity/relationship tracking, and hybrid
  vector+graph retrieval. Use when the user needs grounded context from their knowledge base.
version: 1.0.0
compatibility: Requires curl and a running raged instance (Docker Compose or Kubernetes)
metadata:
  openclaw:
    emoji: "magnifying_glass"
    requires:
      bins:
        - curl
        - jq
      env:
        - RAGED_URL
    primaryEnv: RAGED_URL
    config:
      apiToken:
        description: "Bearer token for raged API authentication (optional if auth is disabled)"
        secret: true
---

# raged — Semantic Knowledge Base with Enrichment & Graph

Store any content and retrieve it via natural-language queries, enriched with metadata extraction and knowledge graph relationships.

raged chunks text, embeds it with a local model (Ollama + nomic-embed-text), stores vectors in Postgres with pgvector, and serves similarity search over an HTTP API. Optionally runs async enrichment (NLP + LLM extraction) and builds a knowledge graph stored in Postgres for entity-aware retrieval.

Content types: source code, markdown docs, blog articles, email threads, PDFs, images, YouTube transcripts, meeting notes, Slack exports, or any text.

## Environment

| Variable | Purpose | Example |
|----------|---------|---------|
| `RAGED_URL` | Base URL of the raged API | `http://localhost:8080` |
| `RAGED_TOKEN` | Bearer token (omit if auth is disabled) | `my-secret-token` |

## Pre-flight: Check Connection

Before running queries or indexing, verify raged is reachable:

```bash
curl -sf "$RAGED_URL/healthz" | jq .
# Expected: {"ok":true}
```

Or use the bundled checker script:

```bash
node scripts/check-connection.mjs "$RAGED_URL"
```

If the health check fails, remind the user to start the stack:

```bash
docker compose up -d   # base stack (Postgres, Ollama, API)
docker compose --profile enrichment up -d   # full stack with enrichment worker
```

## Querying the Knowledge Base

### Basic Query

```bash
curl -s -X POST "$RAGED_URL/query" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $RAGED_TOKEN" \
  -d '{
    "query": "authentication middleware",
    "topK": 5
  }' | jq '.results[] | {score, source, text: (.text | .[0:200])}'
```

Omit the `Authorization` header if raged has no token configured.

Works for any content type — code, docs, articles, transcripts:

```bash
# Find relevant meeting notes
curl -s -X POST "$RAGED_URL/query" \
  -H "Content-Type: application/json" \
  -d '{"query": "Q1 roadmap decisions", "topK": 5}' | jq '.results[]'

# Search indexed blog articles
curl -s -X POST "$RAGED_URL/query" \
  -H "Content-Type: application/json" \
  -d '{"query": "React server components best practices", "topK": 5}' | jq '.results[]'
```

### Query with Filters

Filter by source collection (e.g., a specific repo or content set):

```bash
curl -s -X POST "$RAGED_URL/query" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $RAGED_TOKEN" \
  -d '{
    "query": "error handling",
    "topK": 5,
    "filter": {
      "repoId": "my-repo"
    }
  }' | jq '.results[] | {score, source, text: (.text | .[0:200])}'
```

Filter by content type (when metadata includes `lang`):

```bash
curl -s -X POST "$RAGED_URL/query" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $RAGED_TOKEN" \
  -d '{
    "query": "database connection",
    "topK": 5,
    "filter": {
      "lang": "ts"
    }
  }' | jq '.results[] | {score, source, text: (.text | .[0:200])}'
```

Filter by path prefix:

```bash
curl -s -X POST "$RAGED_URL/query" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $RAGED_TOKEN" \
  -d '{
    "query": "route handler",
    "topK": 5,
    "filter": {
      "path": "src/api/"
    }
  }' | jq '.results[] | {score, source, text: (.text | .[0:200])}'
```

Combine multiple filters (AND logic) by adding more keys to the `filter` object.

### Query Parameters

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `query` | string | **required** | Natural-language search text |
| `topK` | number | `8` | Number of results to return |
| `collection` | string | `docs` | Collection to search |
| `filter` | object | _(none)_ | Key-value filter. Supported direct keys: `chunkIndex`, `docType`, `repoId`, `repoUrl`, `path`, `lang`, `itemUrl`, `enrichmentStatus`. Also supports DSL form with `conditions` + optional `combine` (`and`/`or`). |
| `strategy` | enum | _(auto)_ | Force a strategy: `semantic`, `metadata`, `graph`, `hybrid` |
| `graphExpand` | boolean | `false` | Deprecated. Use `strategy: "graph"` instead |

### Query with Graph Expansion

Use `strategy: "graph"` to expand results with related entities from the knowledge graph:

```bash
curl -s -X POST "$RAGED_URL/query" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $RAGED_TOKEN" \
  -d '{
    "query": "authentication flow",
    "topK": 5,
    "strategy": "graph"
  }' | jq .
```

Response includes both vector results and extracted/expanded entities:

```json
{
  "ok": true,
  "results": [ /* vector search results */ ],
  "graph": {
    "entities": [
      { "name": "AuthService", "type": "class", "depth": 0, "isSeed": true },
      { "name": "JWT", "type": "library", "depth": 1, "isSeed": false }
    ],
    "relationships": [
      { "source": "AuthService", "target": "JWT", "type": "uses" }
    ]
  },
  "routing": {
    "strategy": "graph",
    "method": "explicit",
    "confidence": 1.0,
    "durationMs": 5
  }
}
```

### Filter Keys

| Key | Match Type | Example value |
|-----|-----------|---------|
| `repoId` | exact value | `"my-repo"` |
| `lang` | exact value | `"ts"` |
| `path` | prefix match | `"src/"` |
| `docType` | exact value | `"code"` |
| `enrichmentStatus` | exact value | `"enriched"` |

### Response Shape

```json
{
  "ok": true,
  "results": [
    {
      "id": "my-repo:src/auth.ts:0",
      "score": 0.87,
      "source": "https://github.com/org/repo#src/auth.ts",
      "text": "chunk content...",
      "payload": { "repoId": "...", "lang": "ts", "path": "src/auth.ts" }
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

Results are ordered by similarity score (highest first). `score` ranges 0.0–1.0. For `metadata` strategy, `score` is always `1.0` and `text` may or may not be present — clients must not rely on its absence.

## Ingesting Content

Ingest any text into the knowledge base. raged chunks it, embeds each chunk, and stores vectors in Postgres with pgvector.

### Via the API (any text content)

Send any text directly to the `/ingest` endpoint:

```bash
# Ingest a local file (doc, article, transcript, code, etc.)
text=$(jq -Rs . < notes/2026-02-14-standup.md)

curl -s -X POST "$RAGED_URL/ingest" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $RAGED_TOKEN" \
  -d "{\"collection\":\"docs\",\"items\":[{\"id\":\"meeting-notes:2026-02-14\",\"text\":${text},\"source\":\"notes/2026-02-14-standup.md\",\"metadata\":{\"type\":\"meeting-notes\",\"date\":\"2026-02-14\"}}]}" | jq .
```

```bash
# Ingest a source file
text=$(jq -Rs . < src/main.ts)

curl -s -X POST "$RAGED_URL/ingest" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $RAGED_TOKEN" \
  -d "{\"collection\":\"docs\",\"items\":[{\"id\":\"my-repo:src/main.ts\",\"text\":${text},\"source\":\"https://github.com/org/repo#src/main.ts\",\"metadata\":{\"repoId\":\"my-repo\",\"path\":\"src/main.ts\",\"lang\":\"ts\"}}]}" | jq .
```

Response: `{"ok": true, "upserted": <chunk_count>}`

You can ingest multiple items in a single request. Use any metadata keys that help with filtering later.

### Via the CLI (bulk Git repository indexing)

For indexing entire Git repositories, the CLI automates cloning, scanning, batching, and filtering. From the raged repo:

```bash
cd cli && npm install && npm run build

node dist/index.js index \
  --repo https://github.com/org/repo.git \
  --api "$RAGED_URL" \
  --token "$RAGED_TOKEN" \
  --collection docs
```

### CLI Index Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--repo`, `-r` | string | **required** | Git URL to clone |
| `--api` | string | `http://localhost:8080` | raged API URL |
| `--collection` | string | `docs` | Target collection |
| `--branch` | string | _(default)_ | Branch to clone |
| `--repoId` | string | _(repo URL)_ | Stable identifier for the repo |
| `--token` | string | _(from env)_ | Bearer token |
| `--include` | string | _(all)_ | Only index files matching this prefix |
| `--exclude` | string | _(none)_ | Skip files matching this prefix |
| `--maxFiles` | number | `4000` | Max files to process |
| `--maxBytes` | number | `500000` | Max file size in bytes |
| `--enrich` | boolean | `true` | Enable async enrichment |
| `--no-enrich` | flag | - | Disable async enrichment |
| `--doc-type` | string | _(auto)_ | Override document type detection |

### Via the CLI (arbitrary file ingestion)

For ingesting PDFs, images, Slack exports, or other non-repo content:

```bash
# Ingest a single PDF
node dist/index.js ingest \
  --file path/to/document.pdf \
  --api "$RAGED_URL" \
  --token "$RAGED_TOKEN" \
  --collection docs

# Ingest all files in a directory
node dist/index.js ingest \
  --dir path/to/content/ \
  --api "$RAGED_URL" \
  --token "$RAGED_TOKEN" \
  --collection docs
```

Supported file types: text, code, PDFs (extracted text), images (base64 + EXIF metadata), Slack JSON exports.

### Ingest Request Schema

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `collection` | string | no | Collection name (default: `docs`) |
| `items` | array | **yes** | Array of items to ingest |
| `items[].id` | string | no | Base ID for chunks (auto-generated if omitted) |
| `items[].text` | string | **yes** | Full text to chunk and embed |
| `items[].source` | string | **yes** | Source URL or identifier |
| `items[].metadata` | object | no | Arbitrary metadata stored with chunks |
| `items[].docType` | string | no | Document type (`code`, `text`, `pdf`, `image`, `slack`) |
| `items[].enrich` | boolean | no | Enable async enrichment (default: `true`) |

## Enrichment

When enrichment is enabled (worker running), raged performs async metadata extraction:

- **Tier-1** (sync): Heuristic/AST/EXIF extraction during ingest
- **Tier-2** (async): spaCy NER, keyword extraction, language detection
- **Tier-3** (async): LLM-based summaries and entity extraction

### Check Enrichment Status

```bash
# Get status for a specific document
curl -s "$RAGED_URL/enrichment/status/my-repo:src/auth.ts?collection=docs" \
  -H "Authorization: Bearer $RAGED_TOKEN" | jq .
```

Response:
```json
{
  "status": "enriched",
  "chunks": { "total": 3, "enriched": 3, "pending": 0, "processing": 0, "failed": 0, "none": 0 },
  "extractedAt": "2026-02-14T10:05:00Z",
  "metadata": {
    "tier2": { "entities": [...], "keywords": [...], "language": "en" },
    "tier3": { "summary": "...", "entities": [...] }
  }
}
```

### Get Enrichment Stats

```bash
# System-wide enrichment statistics
curl -s "$RAGED_URL/enrichment/stats" \
  -H "Authorization: Bearer $RAGED_TOKEN" | jq .
```

Via CLI:
```bash
node dist/index.js enrich --show-failed \
  --api "$RAGED_URL" \
  --token "$RAGED_TOKEN"
```

### Trigger Enrichment

```bash
# Enqueue pending items for enrichment
curl -s -X POST "$RAGED_URL/enrichment/enqueue" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $RAGED_TOKEN" \
  -d '{"collection": "docs", "force": false}' | jq .

# Force re-enrichment of all items
curl -s -X POST "$RAGED_URL/enrichment/enqueue" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $RAGED_TOKEN" \
  -d '{"collection": "docs", "force": true}' | jq .
```

Via CLI:
```bash
# Trigger enrichment for pending items
node dist/index.js enrich \
  --api "$RAGED_URL" \
  --token "$RAGED_TOKEN"

# Force re-enrichment
node dist/index.js enrich --force \
  --api "$RAGED_URL" \
  --token "$RAGED_TOKEN"
```

## Knowledge Graph

raged builds a knowledge graph of entities and relationships extracted from documents.

### Query Entity

```bash
# Get entity details, connections, and related documents
curl -s "$RAGED_URL/graph/entity/AuthService" \
  -H "Authorization: Bearer $RAGED_TOKEN" | jq .
```

Response:
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

Via CLI:
```bash
node dist/index.js graph --entity "AuthService" \
  --api "$RAGED_URL" \
  --token "$RAGED_TOKEN"
```

Output:
```
=== Entity: AuthService ===
Type: class
Description: Handles user authentication

=== Connections (2) ===
  → JWT (uses)
  ← UserService (relates_to)

=== Related Documents (3) ===
  - my-repo:src/auth.ts:0
  - my-repo:src/auth.ts:1
  - my-repo:docs/auth.md:0
```

## Error Handling

| HTTP Status | Meaning | Action |
|-------------|---------|--------|
| `200` | Success | Parse JSON response |
| `401` | Unauthorized | Check `RAGED_TOKEN` is set correctly |
| `400` | Bad request | Check required fields (`query` for /query, `items` for /ingest) |
| `5xx` | Server error | Check raged logs: `docker compose logs api` |
| Connection refused | Stack not running | Start with `docker compose up -d` |
