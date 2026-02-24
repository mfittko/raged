---
name: raged
description: >
  Store and retrieve knowledge using raged semantic search with enrichment and knowledge graph.
  Use the raged CLI for all interactions (query, ingest, index, enrich, graph).
  Ingest any content — code, docs, PDFs, images, articles, emails, transcripts, notes — and query
  by natural language with grounded retrieval.
version: 1.0.0
compatibility: Requires Node.js/npm and a running raged instance (Docker Compose or Kubernetes)
metadata:
  openclaw:
    emoji: "magnifying_glass"
    requires:
      bins:
        - node
        - npm
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

raged chunks text, embeds it with a local model (Ollama + nomic-embed-text), stores vectors, and serves similarity search. Optionally runs async enrichment (NLP + LLM extraction) and builds a Neo4j knowledge graph for entity-aware retrieval.

Use the CLI as the primary interface. Do not call raw API endpoints directly in normal skill usage.

Content types: source code, markdown docs, blog articles, email threads, PDFs, images, YouTube transcripts, meeting notes, Slack exports, or any text.

## Environment

| Variable | Purpose | Example |
|----------|---------|---------|
| `RAGED_URL` | Base URL of the raged API | `http://localhost:8080` |
| `RAGED_TOKEN` | Bearer token (omit if auth is disabled) | `my-secret-token` |

## Pre-flight: Check Connection

Before running queries or indexing, verify raged is reachable using the bundled checker script:

```bash
node scripts/check-connection.mjs "$RAGED_URL"
```

If the health check fails, remind the user to start the stack:

```bash
docker compose up -d   # base stack (Qdrant, Ollama, API)
docker compose --profile enrichment up -d   # full stack with Redis, Neo4j, worker
```

## Querying the Knowledge Base

### Basic Query

```bash
cd cli && npm install && npm run build

node dist/index.js query \
  --q "authentication middleware" \
  --topK 5 \
  --api "$RAGED_URL" \
  --token "$RAGED_TOKEN"
```

Omit `--token` if raged auth is disabled.

Works for any content type — code, docs, articles, transcripts:

```bash
node dist/index.js query --q "Q1 roadmap decisions" --topK 5 --api "$RAGED_URL"
node dist/index.js query --q "React server components best practices" --topK 5 --api "$RAGED_URL"
```

### Query with Filters

Filter by repo, language, and path prefix:

```bash
node dist/index.js query \
  --q "route handler" \
  --topK 8 \
  --repoId "my-repo" \
  --lang "ts" \
  --pathPrefix "src/api/" \
  --api "$RAGED_URL" \
  --token "$RAGED_TOKEN"
```

### Query with Summaries and Keywords

```bash
node dist/index.js query \
  --q "authentication flow" \
  --summary medium \
  --keywords \
  --unique \
  --api "$RAGED_URL" \
  --token "$RAGED_TOKEN"
```

### Query Parameters

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `--q` | string | **required** | Natural-language search text |
| `--topK` | number | `8` | Number of results to return |
| `--collection` | string | `docs` | Search a single collection |
| `--collections` | string | _(none)_ | Comma-separated collection names |
| `--allCollections` | flag | `false` | Search all discovered collections |
| `--repoId` | string | _(none)_ | Filter by repository ID |
| `--lang` | string | _(none)_ | Filter by language |
| `--pathPrefix` | string | _(none)_ | Filter by file path prefix |
| `--summary [level]` | flag/string | _(none)_ | Show summary (`short`, `medium`, `long`) |
| `--keywords` | flag | `false` | Show extracted keywords |

## Ingesting Content

Ingest any text into the knowledge base. raged chunks it, embeds each chunk, and stores vectors in Qdrant.

### CLI: Bulk Git Repository Indexing

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
| `--collection` | string | `docs` | Target Qdrant collection |
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

### CLI: Arbitrary File/Directory/URL Ingestion

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

# Ingest a URL
node dist/index.js ingest \
  --url "https://example.com/post" \
  --api "$RAGED_URL" \
  --token "$RAGED_TOKEN" \
  --collection docs
```

Supported file types: text, code, PDFs (extracted text), images (base64 + EXIF metadata), Slack JSON exports.

## Enrichment

When enrichment is enabled (Redis + Neo4j + worker running), raged performs async metadata extraction:

- **Tier-1** (sync): Heuristic/AST/EXIF extraction during ingest
- **Tier-2** (async): spaCy NER, keyword extraction, language detection
- **Tier-3** (async): LLM-based summaries and entity extraction

### Get Enrichment Stats

```bash
# System-wide enrichment statistics (without enqueue)
node dist/index.js enrich --stats \
  --api "$RAGED_URL" \
  --token "$RAGED_TOKEN"
```

### Trigger Enrichment

```bash
# Trigger enrichment for pending items
node dist/index.js enrich \
  --api "$RAGED_URL" \
  --token "$RAGED_TOKEN"

# Force re-enrichment
node dist/index.js enrich --force \
  --api "$RAGED_URL" \
  --token "$RAGED_TOKEN"

# Re-enrich subset using text filter
node dist/index.js enrich --force --filter "auth" \
  --api "$RAGED_URL" \
  --token "$RAGED_TOKEN"
```

## Knowledge Graph

When Neo4j is enabled, raged builds a knowledge graph of entities and relationships extracted from documents.

### Query Entity

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

| Symptom | Meaning | Action |
|---------|---------|--------|
| `401 Unauthorized` in CLI output | Token missing or invalid | Set `RAGED_TOKEN` or pass `--token` |
| `Failed to fetch` / connection refused | Stack not running or wrong URL | Verify `RAGED_URL`; run `docker compose up -d` |
| No/low-quality results | Missing ingestion or weak filters | Re-run `index`/`ingest`; adjust `--topK`, `--repoId`, `--pathPrefix` |
| Graph command returns little data | Neo4j or enrichment not active | Start enrichment profile and run `enrich` |
