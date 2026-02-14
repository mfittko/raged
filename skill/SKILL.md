---
name: rag-stack
description: >
  Index Git repositories and query code context using rag-stack semantic search.
  Use when the user needs to search code, find relevant source files, understand
  a codebase, index a repository for retrieval, or get grounded context about code.
version: 0.1.0
compatibility: Requires curl and a running rag-stack instance (Docker Compose or Kubernetes)
metadata:
  openclaw:
    emoji: "magnifying_glass"
    requires:
      bins:
        - curl
      env:
        - RAG_STACK_URL
    primaryEnv: RAG_STACK_URL
    config:
      apiToken:
        description: "Bearer token for rag-stack API authentication (optional if auth is disabled)"
        secret: true
---

# rag-stack — Semantic Code Search

Index Git repositories and retrieve relevant code context via natural-language queries.

rag-stack chunks source files, embeds them with a local model (Ollama + nomic-embed-text),
stores vectors in Qdrant, and serves similarity search over an HTTP API.

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

## Querying Code

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

### Query with Filters

Filter by repository:

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

Filter by language:

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

## Indexing a Repository

Indexing clones a Git repo, chunks every source file, embeds each chunk, and stores them in Qdrant.

### Via the API (curl)

Send files directly to the `/ingest` endpoint:

```bash
curl -s -X POST "$RAG_STACK_URL/ingest" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $RAG_STACK_TOKEN" \
  -d '{
    "collection": "docs",
    "items": [
      {
        "id": "my-repo:src/main.ts",
        "text": "'"$(cat src/main.ts)"'",
        "source": "https://github.com/org/repo#src/main.ts",
        "metadata": {"repoId": "my-repo", "path": "src/main.ts", "lang": "ts"}
      }
    ]
  }' | jq .
```

Response: `{"ok": true, "upserted": <chunk_count>}`

For bulk indexing, prefer the CLI below — it handles git clone, file scanning, batching, and filtering automatically.

### Via the CLI (recommended for full repos)

The rag-stack CLI automates the full pipeline. From the rag-stack repo:

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
