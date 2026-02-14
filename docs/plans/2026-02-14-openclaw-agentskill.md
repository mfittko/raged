# OpenClaw AgentSkill for rag-stack — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build an OpenClaw AgentSkill that enables OpenClaw agents to index Git repositories and query code context via rag-stack's semantic search API.

**Architecture:** The skill is a `SKILL.md` file (YAML frontmatter + Markdown instructions) that teaches OpenClaw's agent to interact with rag-stack's REST API using `curl`. A small Node.js connectivity checker script provides pre-flight validation. Reference documentation covers advanced API usage. The skill lives in `skill/` at the repo root and can be installed into OpenClaw via symlink or ClawHub publish.

**Tech Stack:** SKILL.md (YAML + Markdown), curl (HTTP API calls), Node.js (connectivity checker), `node:test` (testing)

---

## Task 1: Scaffold skill directory

**Files:**
- Create: `skill/SKILL.md` (placeholder)
- Create: `skill/scripts/` (directory)
- Create: `skill/references/` (directory)

**Step 1: Create directory structure**

```bash
mkdir -p skill/scripts skill/references
```

**Step 2: Create placeholder SKILL.md**

Create `skill/SKILL.md`:

```markdown
---
name: rag-stack
description: Placeholder — will be replaced in Task 3.
---

# rag-stack

Placeholder.
```

**Step 3: Commit**

```bash
git add skill/
git commit -m "feat(skill): scaffold OpenClaw AgentSkill directory"
```

---

## Task 2: Write connectivity checker — failing test

**Files:**
- Create: `skill/scripts/check-connection.test.mjs`

**Step 1: Write the failing test**

Create `skill/scripts/check-connection.test.mjs`:

```javascript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkConnection } from "./check-connection.mjs";

describe("checkConnection", () => {
  it("returns ok when rag-stack health endpoint responds 200", async () => {
    const mockFetch = async (url) => {
      assert.match(url, /\/healthz$/);
      return { ok: true, json: async () => ({ ok: true }) };
    };

    const result = await checkConnection("http://localhost:8080", mockFetch);

    assert.deepStrictEqual(result, { ok: true, url: "http://localhost:8080" });
  });

  it("returns error when health endpoint returns non-200", async () => {
    const mockFetch = async () => ({ ok: false, status: 503 });

    const result = await checkConnection("http://localhost:8080", mockFetch);

    assert.equal(result.ok, false);
    assert.match(result.error, /503/);
  });

  it("returns error when fetch throws (network unreachable)", async () => {
    const mockFetch = async () => {
      throw new Error("ECONNREFUSED");
    };

    const result = await checkConnection("http://localhost:9999", mockFetch);

    assert.equal(result.ok, false);
    assert.match(result.error, /ECONNREFUSED/);
  });

  it("returns error when health body has ok:false", async () => {
    const mockFetch = async () => ({
      ok: true,
      json: async () => ({ ok: false }),
    });

    const result = await checkConnection("http://localhost:8080", mockFetch);

    assert.equal(result.ok, false);
    assert.match(result.error, /ok.*false/i);
  });

  it("strips trailing slash from URL", async () => {
    let calledUrl = "";
    const mockFetch = async (url) => {
      calledUrl = url;
      return { ok: true, json: async () => ({ ok: true }) };
    };

    await checkConnection("http://localhost:8080/", mockFetch);

    assert.equal(calledUrl, "http://localhost:8080/healthz");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `node --test skill/scripts/check-connection.test.mjs`

Expected: FAIL — `Cannot find module './check-connection.mjs'`

---

## Task 3: Write connectivity checker — implementation

**Files:**
- Create: `skill/scripts/check-connection.mjs`

**Step 1: Implement the connectivity checker**

Create `skill/scripts/check-connection.mjs`:

```javascript
/**
 * Pre-flight check: verifies rag-stack is running and responsive.
 * Used by the OpenClaw agent before issuing query/index commands.
 *
 * Usage: node check-connection.mjs [url]
 *   url defaults to RAG_STACK_URL env var, then http://localhost:8080
 */

export async function checkConnection(url, fetchFn = fetch) {
  const baseUrl = url.replace(/\/+$/, "");
  try {
    const res = await fetchFn(`${baseUrl}/healthz`);
    if (!res.ok) {
      return { ok: false, url: baseUrl, error: `Health check returned ${res.status}` };
    }
    const body = await res.json();
    if (!body.ok) {
      return { ok: false, url: baseUrl, error: "Health endpoint returned ok:false" };
    }
    return { ok: true, url: baseUrl };
  } catch (err) {
    return { ok: false, url: baseUrl, error: err.message };
  }
}

// CLI entry point
const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("/check-connection.mjs");

if (isMain) {
  const url = process.argv[2] || process.env.RAG_STACK_URL || "http://localhost:8080";
  const result = await checkConnection(url);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}
```

**Step 2: Run tests to verify they pass**

Run: `node --test skill/scripts/check-connection.test.mjs`

Expected: PASS — 5 tests passing

**Step 3: Commit**

```bash
git add skill/scripts/check-connection.mjs skill/scripts/check-connection.test.mjs
git commit -m "feat(skill): add connectivity checker with tests"
```

---

## Task 4: Write SKILL.md — frontmatter and overview

**Files:**
- Modify: `skill/SKILL.md` (replace placeholder)

**Step 1: Write SKILL.md with frontmatter, overview, and health check section**

Replace `skill/SKILL.md` entirely:

```markdown
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
```

**Step 2: Commit**

```bash
git add skill/SKILL.md
git commit -m "feat(skill): write SKILL.md frontmatter and overview"
```

---

## Task 5: Write SKILL.md — query instructions

**Files:**
- Modify: `skill/SKILL.md` (append query section)

**Step 1: Append query section to SKILL.md**

Add the following after the pre-flight section:

```markdown
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
```

**Step 2: Commit**

```bash
git add skill/SKILL.md
git commit -m "feat(skill): add query instructions to SKILL.md"
```

---

## Task 6: Write SKILL.md — index instructions

**Files:**
- Modify: `skill/SKILL.md` (append index section)

**Step 1: Append index section to SKILL.md**

Add the following after the query section:

```markdown
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
```

**Step 2: Commit**

```bash
git add skill/SKILL.md
git commit -m "feat(skill): add index instructions and error handling to SKILL.md"
```

---

## Task 7: Write reference documentation

**Files:**
- Create: `skill/references/REFERENCE.md`

**Step 1: Create detailed API reference**

Create `skill/references/REFERENCE.md`:

```markdown
# rag-stack API Reference

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
| rag-stack API | `http://localhost:8080` | HTTP gateway |
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
```

**Step 2: Commit**

```bash
git add skill/references/REFERENCE.md
git commit -m "feat(skill): add API reference documentation"
```

---

## Task 8: Add example OpenClaw configuration

**Files:**
- Create: `skill/README.md`

**Step 1: Create installation and configuration guide**

Create `skill/README.md`:

```markdown
# rag-stack OpenClaw Skill

An [OpenClaw](https://openclaw.ai/) AgentSkill that gives your agent semantic
code search over indexed Git repositories.

## Install

### Option A: Symlink (development)

```bash
ln -s /path/to/rag-stack/skill ~/.openclaw/skills/rag-stack
```

### Option B: Copy

```bash
cp -r /path/to/rag-stack/skill ~/.openclaw/skills/rag-stack
```

## Configure

Add to `~/.openclaw/openclaw.json`:

```json
{
  "skills": {
    "entries": {
      "rag-stack": {
        "enabled": true,
        "env": {
          "RAG_STACK_URL": "http://localhost:8080",
          "RAG_STACK_TOKEN": ""
        }
      }
    }
  }
}
```

Set `RAG_STACK_TOKEN` only if your rag-stack instance has `RAG_API_TOKEN` configured.

## Prerequisites

1. A running rag-stack instance: `docker compose up -d` (from the rag-stack repo)
2. `curl` on PATH
3. The Ollama embedding model pulled: `curl http://localhost:11434/api/pull -d '{"name":"nomic-embed-text"}'`

## Verify

```bash
# In an OpenClaw session, ask:
"Is rag-stack running?"
# The agent will call /healthz and report status.
```
```

**Step 2: Commit**

```bash
git add skill/README.md
git commit -m "docs(skill): add installation and configuration guide"
```

---

## Task 9: Validate skill and final commit

**Files:**
- Verify: `skill/SKILL.md` (frontmatter valid)
- Verify: `skill/scripts/check-connection.mjs` (tests pass)
- Verify: `skill/references/REFERENCE.md` (exists)
- Verify: `skill/README.md` (exists)

**Step 1: Run connectivity checker tests**

Run: `node --test skill/scripts/check-connection.test.mjs`

Expected: PASS — 5 tests passing

**Step 2: Verify SKILL.md frontmatter is valid YAML**

```bash
node -e "
  const fs = require('fs');
  const content = fs.readFileSync('skill/SKILL.md', 'utf8');
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) { console.error('No frontmatter found'); process.exit(1); }
  console.log('Frontmatter found (' + match[1].split('\n').length + ' lines)');
  console.log('OK');
"
```

Expected: `Frontmatter found (N lines)` and `OK`

**Step 3: Verify skill directory structure**

```bash
ls -R skill/
```

Expected:
```
skill/:
README.md  SKILL.md  references/  scripts/

skill/references:
REFERENCE.md

skill/scripts:
check-connection.mjs  check-connection.test.mjs
```

**Step 4: Final verification commit (if any unstaged changes)**

```bash
git status
# If clean: done
# If changes: git add skill/ && git commit -m "chore(skill): final cleanup"
```
