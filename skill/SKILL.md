---
name: rag-stack
description: >
  Store and retrieve knowledge using rag-stack semantic search. Ingest any text
  content — code, docs, articles, emails, transcripts, notes — and query it by
  natural language. Use when the user needs grounded context from their knowledge base.
version: 0.1.0
compatibility: Requires curl and a running rag-stack instance (Docker Compose or Kubernetes)
metadata:
  openclaw:
    emoji: "magnifying_glass"
    requires:
      bins:
        - curl
        - jq
      env:
        - RAG_STACK_URL
    primaryEnv: RAG_STACK_URL
    config:
      apiToken:
        description: "Bearer token for rag-stack API authentication (optional if auth is disabled)"
        secret: true
---

# rag-stack — Semantic Knowledge Base

Store any text content and retrieve it via natural-language queries.

rag-stack chunks text, embeds it with a local model (Ollama + nomic-embed-text),
stores vectors in Qdrant, and serves similarity search over an HTTP API.
Content types: source code, markdown docs, blog articles, email threads,
YouTube transcripts, meeting notes, or any plain text.

## Environment

| Variable | Purpose | Example |
|----------|---------|---------|
| `RAG_STACK_URL` | Base URL of the rag-stack API | `http://localhost:8080` |
| `RAG_STACK_TOKEN` | Bearer token (omit if auth is disabled) | `my-secret-token` |

## Pre-flight: Check Connection

Before running queries or indexing, verify rag-stack is reachable:

```bash
curl -sf "$RAG_STACK_URL/healthz" | jq .
# Expected: {"ok":true}
```

Or use the bundled checker script:

```bash
node scripts/check-connection.mjs "$RAG_STACK_URL"
```

If the health check fails, remind the user to start the stack:

```bash
docker compose up -d   # from the rag-stack repo root
```

## Querying the Knowledge Base

### Basic Query

```bash
curl -s -X POST "$RAG_STACK_URL/query" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $RAG_STACK_TOKEN" \
  -d '{
    "query": "authentication middleware",
    "topK": 5
  }' | jq '.results[] | {score, source, text: (.text | .[0:200])}'
```

Omit the `Authorization` header if rag-stack has no token configured.

Works for any content type — code, docs, articles, transcripts:

```bash
# Find relevant meeting notes
curl -s -X POST "$RAG_STACK_URL/query" \
  -H "Content-Type: application/json" \
  -d '{"query": "Q1 roadmap decisions", "topK": 5}' | jq '.results[]'

# Search indexed blog articles
curl -s -X POST "$RAG_STACK_URL/query" \
  -H "Content-Type: application/json" \
  -d '{"query": "React server components best practices", "topK": 5}' | jq '.results[]'
```

### Query with Filters

Filter by source collection (e.g., a specific repo or content set):

```bash
curl -s -X POST "$RAG_STACK_URL/query" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $RAG_STACK_TOKEN" \
  -d '{
    "query": "error handling",
    "topK": 5,
    "filter": {
      "must": [
        {"key": "repoId", "match": {"value": "my-repo"}}
      ]
    }
  }' | jq '.results[] | {score, source, text: (.text | .[0:200])}'
```

Filter by content type (when metadata includes `lang`):

```bash
curl -s -X POST "$RAG_STACK_URL/query" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $RAG_STACK_TOKEN" \
  -d '{
    "query": "database connection",
    "topK": 5,
    "filter": {
      "must": [
        {"key": "lang", "match": {"value": "ts"}}
      ]
    }
  }' | jq '.results[] | {score, source, text: (.text | .[0:200])}'
```

Filter by path prefix:

```bash
curl -s -X POST "$RAG_STACK_URL/query" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $RAG_STACK_TOKEN" \
  -d '{
    "query": "route handler",
    "topK": 5,
    "filter": {
      "must": [
        {"key": "path", "match": {"text": "src/api/"}}
      ]
    }
  }' | jq '.results[] | {score, source, text: (.text | .[0:200])}'
```

Combine multiple filters (AND logic) by adding entries to the `must` array.

### Query Parameters

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `query` | string | **required** | Natural-language search text |
| `topK` | number | `8` | Number of results to return |
| `collection` | string | `docs` | Qdrant collection to search |
| `filter` | object | _(none)_ | Qdrant filter with `must` array |

### Filter Keys

| Key | Match Type | Example |
|-----|-----------|---------|
| `repoId` | exact value | `{"key":"repoId","match":{"value":"my-repo"}}` |
| `lang` | exact value | `{"key":"lang","match":{"value":"ts"}}` |
| `path` | text prefix | `{"key":"path","match":{"text":"src/"}}` |

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
  ]
}
```

Results are ordered by similarity score (highest first). `score` ranges 0.0–1.0.

## Ingesting Content

Ingest any text into the knowledge base. rag-stack chunks it, embeds each chunk, and stores vectors in Qdrant.

### Via the API (any text content)

Send any text directly to the `/ingest` endpoint:

```bash
# Ingest a local file (doc, article, transcript, code, etc.)
text=$(jq -Rs . < notes/2026-02-14-standup.md)

curl -s -X POST "$RAG_STACK_URL/ingest" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $RAG_STACK_TOKEN" \
  -d "{\"collection\":\"docs\",\"items\":[{\"id\":\"meeting-notes:2026-02-14\",\"text\":${text},\"source\":\"notes/2026-02-14-standup.md\",\"metadata\":{\"type\":\"meeting-notes\",\"date\":\"2026-02-14\"}}]}" | jq .
```

```bash
# Ingest a source file
text=$(jq -Rs . < src/main.ts)

curl -s -X POST "$RAG_STACK_URL/ingest" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $RAG_STACK_TOKEN" \
  -d "{\"collection\":\"docs\",\"items\":[{\"id\":\"my-repo:src/main.ts\",\"text\":${text},\"source\":\"https://github.com/org/repo#src/main.ts\",\"metadata\":{\"repoId\":\"my-repo\",\"path\":\"src/main.ts\",\"lang\":\"ts\"}}]}" | jq .
```

Response: `{"ok": true, "upserted": <chunk_count>}`

You can ingest multiple items in a single request. Use any metadata keys that help with filtering later.

### Via the CLI (bulk Git repository indexing)

For indexing entire Git repositories, the CLI automates cloning, scanning, batching, and filtering. From the rag-stack repo:

```bash
cd cli && npm install && npm run build

node dist/index.js index \
  --repo https://github.com/org/repo.git \
  --api "$RAG_STACK_URL" \
  --token "$RAG_STACK_TOKEN" \
  --collection docs
```

### CLI Index Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--repo`, `-r` | string | **required** | Git URL to clone |
| `--api` | string | `http://localhost:8080` | rag-stack API URL |
| `--collection` | string | `docs` | Target Qdrant collection |
| `--branch` | string | _(default)_ | Branch to clone |
| `--repoId` | string | _(repo URL)_ | Stable identifier for the repo |
| `--token` | string | _(from env)_ | Bearer token |
| `--include` | string | _(all)_ | Only index files matching this prefix |
| `--exclude` | string | _(none)_ | Skip files matching this prefix |
| `--maxFiles` | number | `4000` | Max files to process |
| `--maxBytes` | number | `500000` | Max file size in bytes |

### Ingest Request Schema

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `collection` | string | no | Collection name (default: `docs`) |
| `items` | array | **yes** | Array of items to ingest |
| `items[].id` | string | no | Base ID for chunks (auto-generated if omitted) |
| `items[].text` | string | **yes** | Full text to chunk and embed |
| `items[].source` | string | **yes** | Source URL or identifier |
| `items[].metadata` | object | no | Arbitrary metadata stored with chunks |

## Error Handling

| HTTP Status | Meaning | Action |
|-------------|---------|--------|
| `200` | Success | Parse JSON response |
| `401` | Unauthorized | Check `RAG_STACK_TOKEN` is set correctly |
| `400` | Bad request | Check required fields (`query` for /query, `items` for /ingest) |
| `5xx` | Server error | Check rag-stack logs: `docker compose logs api` |
| Connection refused | Stack not running | Start with `docker compose up -d` |
