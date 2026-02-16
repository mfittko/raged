# Metadata Extraction & Knowledge Graph — Design

> **Status:** Approved design — not yet implemented
> **Date:** 2026-02-14
> **Scope:** Automatic metadata extraction during ingestion, async enrichment worker, Neo4j knowledge graph, pluggable LLM adapter

## Problem

The current ingestion pipeline stores minimal metadata: `repoId`, `path`, `lang`, `bytes` for code files, plus whatever the caller passes in `items[].metadata`. There is no automatic extraction — no summaries, no entity detection, no relationship mapping. This limits retrieval to pure vector similarity. The roadmap calls for relationship-aware queries ("what docs reference this function?", "show the email thread behind this design") which require structured metadata and a graph layer.

## Requirements

- **All document types**: code, Slack messages, emails, meeting notes/transcripts, images, PDFs, blog posts/articles, generic text
- **Tiered extraction**: heuristics first (free, fast), NLP second (cheap, fast), LLM third (powerful, expensive)
- **Async enrichment**: ingest stays fast; LLM extraction happens in a background worker
- **Pluggable LLM**: adapter pattern for Ollama, Anthropic, OpenAI with smart model routing
- **Neo4j knowledge graph**: entities and relationships extracted and stored for graph traversal
- **Hybrid retrieval**: vector search + graph expansion at query time
- **Backwards-compatible**: existing API and CLI behavior unchanged unless new flags are used

## Architecture

```mermaid
graph TD
  client[CLI / Agent]
  api[RAG API]
  qdrant[(Qdrant)]
  redis[(Redis Queue)]
  ollama[(Ollama Embeddings)]
  worker[Enrichment Worker (Python)]
  neo4j[(Neo4j Graph)]

  client -->|POST /ingest| api
  api -->|Chunk + upsert vectors| qdrant
  api -->|Enqueue enrichment task| redis
  api -->|Create embeddings| ollama
  redis -->|BRPOP task| worker
  worker -->|Read + update payload| qdrant
  worker -->|Run tier-3 extraction| ollama
  worker -->|Upsert entities + relationships| neo4j
```

**New services**: Redis (task queue), Neo4j (graph DB), enrichment worker (Python).

**Key principle**: The API stays fast and stateless. All expensive LLM work happens in the worker.

## Extraction Tiers

| Tier | When | How | Cost | Latency |
|------|------|-----|------|---------|
| **Tier 1** | Synchronous, during `/ingest` | Heuristics, parsers, EXIF, Tree-sitter AST | ~Free | <100ms |
| **Tier 2** | Async, enrichment worker | NLP libraries — spaCy NER, TextRank keywords, fastText language detection | Cheap | <500ms |
| **Tier 3** | Async, enrichment worker | LLM via pluggable adapter — summaries, intent, relationships, image descriptions | $$ | 1-5s |

All three tiers write to the same Qdrant payload. Tier 1 happens before the ingest response returns. Tiers 2 and 3 run in the background worker and update the payload + write to Neo4j when done.

## Document Type Detection

A new optional field `docType` on ingest items. If omitted, the API infers it:

```
1. Explicit: item.docType = "slack" → use that
2. Metadata hints: item.metadata.channel → slack, item.metadata.from → email
3. Source URL pattern: github.com → code, slack.com → slack
4. Content sniffing: email headers → email, JSON with "messages" → slack export
5. File extension: .py → code, .pdf → pdf, .png → image
6. Fallback: "text" (generic)
```

## Tier-1 Extraction (Synchronous)

Per-type heuristic extraction at ingest time. No LLM involved.

| Type | Tier-1 Fields | How Extracted |
|------|--------------|---------------|
| **code** | `lang`, `path`, `functions[]`, `classes[]`, `imports[]`, `exports[]` | Tree-sitter AST parsing |
| **slack** | `channel`, `threadId`, `participants`, `timestamp` | JSON structure / field presence |
| **email** | `from`, `to`, `cc`, `subject`, `date`, `messageId`, `inReplyTo` | Header parsing (RFC 2822) |
| **meeting** | `date`, `duration`, `platform`, `participants` | Regex patterns in content |
| **pdf** | `title`, `author`, `pageCount`, `createdDate` | PDF metadata fields (caller-provided or parsed) |
| **image** | `mimeType`, `dimensions`, `exif` (GPS coords, date taken, camera, orientation, exposure) | EXIF parser (sharp / exif-reader) |
| **article** | `url`, `author`, `publishDate`, `title` | Open Graph / structured data / regex |
| **text** | _(none beyond base)_ | Fallback type |

### Base Payload (all types)

Every ingested chunk gets these fields:

```json
{
  "text": "...",
  "source": "...",
  "chunkIndex": 0,
  "docType": "code",
  "ingestedAt": "2026-02-14T...",
  "enrichmentStatus": "pending",
  "tier1Meta": { ... }
}
```

`enrichmentStatus` tracks the async pipeline: `pending` → `processing` → `enriched` (or `failed`).

## Tier-2 Extraction (Async, NLP)

Runs first in the worker. Applied to all document types.

| Extraction | Library | Output |
|------------|---------|--------|
| Named entities | spaCy (en_core_web_sm) | `entities: [{text, label}]` — PERSON, ORG, DATE, LOC |
| Keywords | TextRank (via spaCy) | `keywords: string[]` — top 5-10 key phrases |
| Language detection | fastText (lid.176) | `language: "en"` |
| Topic classification | BERTopic or simple classifier | `topics: string[]` |

The enrichment worker is written in Python (native access to spaCy, BERTopic, fastText). The API and CLI remain TypeScript.

## Tier-3 Extraction (Async, LLM)

Uses structured output (tool_use / function calling) with per-type schemas.

| Type | LLM Extracts |
|------|-------------|
| **code** | `summary`, `purpose`, `complexity: low/med/high` |
| **slack** | `summary`, `decisions[]`, `actionItems[{task, assignee}]`, `sentiment` |
| **email** | `urgency: low/normal/high/critical`, `intent: request/fyi/approval/escalation`, `actionItems[]`, `summary` |
| **meeting** | `decisions[]`, `actionItems[{task, assignee, deadline}]`, `topicSegments[{topic, summary}]` |
| **image** | `description`, `detectedObjects[]`, `ocrText`, `imageType: photo/diagram/screenshot/chart` |
| **pdf** | `summary`, `keyEntities[]`, `sections[{title, summary}]` |
| **article** | `summary`, `takeaways[]`, `tags[]`, `targetAudience` |
| **text** | `summary`, `keyEntities[]` |

### Entity & Relationship Extraction (also tier-3)

Every item gets a relationship extraction pass on top of type-specific extraction:

```json
{
  "entities": [
    { "name": "AuthService", "type": "class", "description": "..." }
  ],
  "relationships": [
    { "source": "AuthService", "target": "JWT", "type": "uses", "description": "..." }
  ]
}
```

These entities and relationships are written to Neo4j.

### Document-Level vs Chunk-Level

| Enrichment | Level | Why |
|------------|-------|-----|
| Keywords, named entities | Per chunk | Vary across chunks |
| Summary, intent, urgency | Per document (first chunk or concatenated) | Applies to the whole item |
| Relationships, action items | Per document | Cross-chunk context needed |
| Image description | Per document | One image = one description |

The worker groups chunks by `baseId`. When the last chunk finishes tier-2, it triggers a document-level tier-3 pass that reads all chunks together.

## Pluggable LLM Adapter

### Interface

```
ExtractorAdapter {
  extractMetadata(text, docType, schema) → structured metadata
  extractEntities(text) → entities[] + relationships[]
  describeImage(imageBuffer, context?) → description + objects + ocrText
  isAvailable() → boolean
}
```

### Providers

| Provider | Models | Configuration |
|----------|--------|---------------|
| **Ollama** (local) | llama3, mistral, llava (multimodal) | `EXTRACTOR_PROVIDER=ollama`, `EXTRACTOR_MODEL_FAST=llama3` |
| **Anthropic** | Claude Sonnet/Haiku | `EXTRACTOR_PROVIDER=anthropic`, `ANTHROPIC_API_KEY=...` |
| **OpenAI** | GPT-4o, GPT-4o-mini | `EXTRACTOR_PROVIDER=openai`, `OPENAI_API_KEY=...` |

### Smart Routing

| Task | Route | Reasoning |
|------|-------|-----------|
| Type-specific metadata (summary, tags) | Fast model (Haiku, 4o-mini, llama3) | Straightforward extraction |
| Entity + relationship extraction | Capable model (Sonnet, 4o) | Needs reasoning about implicit relationships |
| Image description | Multimodal model (Sonnet, 4o, llava) | Requires vision |
| Fallback on failure | Upgrade to capable model | Automatic retry |

Configuration:

```
EXTRACTOR_PROVIDER=anthropic
EXTRACTOR_MODEL_FAST=claude-haiku-4-5-20251001
EXTRACTOR_MODEL_CAPABLE=claude-sonnet-4-5-20250929
```

### Structured Output Strategy

- **Anthropic**: `tool_use` with JSON schema
- **OpenAI**: `response_format` with JSON schema
- **Ollama**: JSON mode prompt + validation + retry

## Neo4j Graph Schema

### Node Types

```
(:Entity {
  name: string,
  type: string,           // "person", "class", "concept", "project", "org"
  description: string,
  firstSeen: datetime,
  lastSeen: datetime,
  mentionCount: int
})

(:Document {
  id: string,             // same as Qdrant base ID
  docType: string,
  source: string,
  collection: string,
  ingestedAt: datetime,
  summary: string
})
```

### Edge Types

| Edge | Meaning | Example |
|------|---------|---------|
| `MENTIONS` | Document mentions an entity | `(doc)-[:MENTIONS]->(entity)` |
| `RELATES_TO` | Entity-to-entity relationship | `(AuthService)-[:RELATES_TO {type: "uses"}]->(JWT)` |
| `REFERENCES` | Document references another document | `(email)-[:REFERENCES]->(design_doc)` |
| `REPLY_TO` | Thread/conversation chain | `(slack_msg_2)-[:REPLY_TO]->(slack_msg_1)` |
| `AUTHORED_BY` | Content attribution | `(doc)-[:AUTHORED_BY]->(person)` |
| `DEPENDS_ON` | Code dependency | `(fileA)-[:DEPENDS_ON]->(fileB)` |

`RELATES_TO` carries a `type` property for the specific relationship kind (uses, implements, discusses, supersedes, etc.).

### Query Patterns Enabled

| Query | Cypher |
|-------|--------|
| What docs reference this function? | `MATCH (d:Document)-[:MENTIONS]->(e {name: "handleAuth"}) RETURN d` |
| Show the email thread about this design | `MATCH (d)-[:REFERENCES]->(design) MATCH (d)-[:REPLY_TO*]-(thread) RETURN thread` |
| What depends on library X? | `MATCH (e)-[:DEPENDS_ON*]->(lib {name: "X"}) RETURN e` |

### Hybrid Retrieval (Vector + Graph)

1. Vector search in Qdrant → top N results
2. Extract entity names from results
3. Graph expansion in Neo4j → find neighbors within 1-2 hops
4. Fetch those neighbor documents from Qdrant
5. Merge and re-rank

## Enrichment Worker

### Worker Flow

```
loop forever:
  1. BRPOP from Redis queue "enrichment:pending"
  2. Parse task: { qdrantId, collection, docType, text, tier1Meta }
  3. Set enrichmentStatus = "processing" in Qdrant
  4. Run tier-2: spaCy NER, keywords, language detection
  5. Run tier-3: LLM metadata extraction (type-specific schema)
  6. Run tier-3: LLM entity + relationship extraction
  7. Update Qdrant payload with all extracted metadata
  8. Upsert entities + edges to Neo4j
  9. Set enrichmentStatus = "enriched" in Qdrant
  on error:
  10. Set enrichmentStatus = "failed", log error
  11. Push to "enrichment:dead-letter" after 3 retries
```

### Redis Queue Schema

```json
{
  "taskId": "uuid",
  "qdrantId": "my-repo:src/auth.ts:0",
  "collection": "docs",
  "docType": "code",
  "baseId": "my-repo:src/auth.ts",
  "chunkIndex": 0,
  "totalChunks": 3,
  "text": "...",
  "source": "...",
  "tier1Meta": { "lang": "ts", "functions": ["handleAuth"] },
  "attempt": 1,
  "enqueuedAt": "2026-02-14T..."
}
```

### Concurrency & Scaling

- Worker runs N concurrent tasks (configurable, default 4)
- Multiple worker instances can run against the same Redis queue
- Rate limiting per LLM provider to respect API limits
- Backpressure: if queue depth > threshold, skip tier-3 for low-priority doc types

## API Changes

All changes are backwards-compatible — existing behavior unchanged.

### Updated `POST /ingest`

New optional fields:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `items[].docType` | string | auto-detect | Document type hint |
| `enrich` | boolean | `true` | Whether to enqueue for async enrichment |

Updated response:

```json
{
  "ok": true,
  "upserted": 12,
  "enrichment": {
    "enqueued": 12,
    "docTypes": { "code": 12 }
  }
}
```

### New `GET /enrichment/status/:baseId`

```json
{
  "baseId": "my-repo:src/auth.ts",
  "status": "enriched",
  "chunks": { "total": 3, "enriched": 3 },
  "extractedAt": "2026-02-14T...",
  "metadata": {
    "tier2": { "entities": [], "keywords": [] },
    "tier3": { "summary": "...", "relationships": [] }
  }
}
```

### New `GET /enrichment/stats`

```json
{
  "queue": { "pending": 42, "processing": 4, "deadLetter": 1 },
  "totals": { "enriched": 1205, "failed": 3 },
  "avgProcessingMs": { "tier2": 95, "tier3": 2100 },
  "providers": { "anthropic": { "requests": 1208, "errors": 3 } }
}
```

### Updated `POST /query`

New optional parameter:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `graphExpand` | boolean | `false` | Expand results via Neo4j graph traversal |

When `graphExpand: true`, response includes a `graph` field:

```json
{
  "ok": true,
  "results": [],
  "graph": {
    "entities": [
      { "name": "AuthService", "type": "class", "mentionCount": 5 }
    ],
    "relationships": [
      { "source": "AuthService", "target": "JWT", "type": "uses" }
    ]
  }
}
```

### New `GET /graph/entity/:name`

```json
{
  "entity": { "name": "AuthService", "type": "class", "description": "..." },
  "connections": [
    { "entity": "JWT", "relationship": "uses", "direction": "outgoing" }
  ],
  "documents": [
    { "id": "my-repo:src/auth.ts", "docType": "code", "source": "..." }
  ]
}
```

### New `POST /enrichment/enqueue`

Trigger enrichment for already-ingested content. Scans Qdrant for items with `enrichmentStatus != "enriched"` and pushes them to Redis.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `collection` | string | `docs` | Collection to scan |
| `force` | boolean | `false` | Re-enrich already-enriched items |

## CLI Changes

### Updated `raged-index index`

| New Flag | Type | Default | Description |
|----------|------|---------|-------------|
| `--enrich` | boolean | `true` | Enqueue for async enrichment |
| `--no-enrich` | - | - | Skip enrichment (current behavior) |
| `--doc-type` | string | auto-detect | Force document type for all files |

### New `raged-index ingest`

Ingest arbitrary files from disk (not just git repos):

```bash
raged-index ingest --file ./notes/standup.md
raged-index ingest --dir ./knowledge/
raged-index ingest --file ./export.json --doc-type slack
raged-index ingest --file ./diagram.png
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--file` | string | - | Single file path |
| `--dir` | string | - | Directory to recursively ingest |
| `--doc-type` | string | auto-detect | Document type hint |
| `--collection` | string | `docs` | Target collection |
| `--api` | string | `http://localhost:8080` | API URL |
| `--token` | string | env | Bearer token |
| `--no-enrich` | - | - | Skip enrichment |

### New `raged-index enrich`

```bash
raged-index enrich --api http://localhost:8080
raged-index enrich --collection docs
raged-index enrich --force
raged-index enrich --stats-only
```

### New `raged-index graph`

```bash
raged-index graph --entity "AuthService"
raged-index graph --entity "AuthService" --depth 2
```

## Error Handling

| Failure | Handling |
|---------|----------|
| LLM provider unreachable | Retry 3x with exponential backoff, then dead-letter |
| LLM returns invalid structured output | Validate against schema, retry with stricter prompt, fallback to partial extraction |
| Qdrant update fails | Retry, leave `enrichmentStatus: "processing"` — worker picks up on restart |
| Neo4j write fails | Retry, Qdrant payload still updated (graph is best-effort) |
| spaCy/NLP crash | Skip tier-2, proceed to tier-3 LLM extraction |
| Image too large for multimodal LLM | Resize before sending, note in metadata |
| Unsupported document type | Fall back to generic "text" extraction |

Dead letter queue: after 3 failed attempts, tasks move to `enrichment:dead-letter` in Redis. `raged-index enrich --stats-only` shows stats for inspection.

## Observability

The enrichment worker logs structured JSON:

```json
{
  "level": "info",
  "event": "enrichment_complete",
  "taskId": "...",
  "baseId": "my-repo:src/auth.ts",
  "docType": "code",
  "tier2_ms": 120,
  "tier3_ms": 2340,
  "entities_extracted": 5,
  "relationships_extracted": 3,
  "provider": "anthropic",
  "model": "claude-haiku-4-5-20251001"
}
```

## Infrastructure: Docker Compose

Updated `docker-compose.yml` adds three new services:

```yaml
services:
  # --- existing services (unchanged) ---
  qdrant:
    image: qdrant/qdrant:v1.10.0
    ports: ["6333:6333"]
    volumes: ["qdrant_storage:/qdrant/storage"]

  ollama:
    image: ollama/ollama:latest
    ports: ["11434:11434"]
    volumes: ["ollama:/root/.ollama"]

  api:
    build: ./api
    environment:
      QDRANT_URL: "http://qdrant:6333"
      OLLAMA_URL: "http://ollama:11434"
      QDRANT_COLLECTION: "docs"
      VECTOR_SIZE: "768"
      DISTANCE: "Cosine"
      EMBED_MODEL: "nomic-embed-text"
      PORT: "8080"
      RAGED_API_TOKEN: ""
      ENRICHMENT_ENABLED: "false"              # NEW (opt-in)
    ports: ["8080:8080"]
    depends_on: [qdrant, ollama]

  # --- new services ---
  redis:
    image: redis:7-alpine
    ports: ["6379:6379"]
    volumes: ["redis_data:/data"]
    command: redis-server --appendonly yes      # persistence

  neo4j:
    image: neo4j:5-community
    ports:
      - "7474:7474"   # browser UI
      - "7687:7687"   # bolt protocol
    environment:
      NEO4J_AUTH: "${NEO4J_AUTH:-}"
      NEO4J_PLUGINS: '["apoc"]'               # utility procedures
    volumes: ["neo4j_data:/data"]

  enrichment-worker:
    build: ./worker
    environment:
      REDIS_URL: "redis://redis:6379"
      QDRANT_URL: "http://qdrant:6333"
      NEO4J_URL: "bolt://neo4j:7687"
      NEO4J_USER: "neo4j"
      NEO4J_PASSWORD: "${NEO4J_PASSWORD:-}"
      OLLAMA_URL: "http://ollama:11434"
      EXTRACTOR_PROVIDER: "ollama"
      EXTRACTOR_MODEL_FAST: "llama3"
      EXTRACTOR_MODEL_CAPABLE: "llama3"
      EXTRACTOR_MODEL_VISION: "llava"
      WORKER_CONCURRENCY: "4"
    depends_on: [redis, neo4j, qdrant, ollama]

volumes:
  qdrant_storage:
  ollama:
  redis_data:
  neo4j_data:
```

### Docker Compose Profiles (optional convenience)

For users who want the current lightweight stack without enrichment:

```yaml
  redis:
    profiles: ["enrichment", "full"]
    # ...
  neo4j:
    profiles: ["enrichment", "full"]
    # ...
  enrichment-worker:
    profiles: ["enrichment", "full"]
    # ...
```

- `docker compose up -d` — starts only api + qdrant + ollama (current behavior)
- `docker compose --profile enrichment up -d` — starts all services including enrichment
- `docker compose --profile full up -d` — alias for everything

## Infrastructure: Helm Chart

New templates and values for the three new services.

### New Templates

| Template | Resource | Purpose |
|----------|----------|---------|
| `redis-deployment.yaml` | Deployment | Redis 7 single instance |
| `redis-service.yaml` | Service | ClusterIP on port 6379 |
| `redis-pvc.yaml` | PVC | Persistent storage for AOF |
| `neo4j-statefulset.yaml` | StatefulSet | Neo4j 5 Community with stable storage |
| `neo4j-service.yaml` | Service | ClusterIP on ports 7474 + 7687 |
| `neo4j-secret.yaml` | Secret | Neo4j credentials |
| `worker-deployment.yaml` | Deployment | Enrichment worker (Python) |
| `worker-configmap.yaml` | ConfigMap | Worker environment configuration |

### Updated `values.yaml`

```yaml
# --- existing values (unchanged) ---
api:
  # ... existing config ...
  env:
    # ... existing env ...
    REDIS_URL: ""  # auto-set by template if enrichment.enabled

# --- new values ---
enrichment:
  enabled: false                               # opt-in
  worker:
    image:
      repository: your-registry/rag-worker
      tag: "1.0.0"
      pullPolicy: IfNotPresent
    replicas: 1
    concurrency: 4
    resources: {}
    extractor:
      provider: "ollama"                       # ollama | anthropic | openai
      modelFast: "llama3"
      modelCapable: "llama3"
      modelVision: "llava"
      anthropicApiKey: ""
      openaiApiKey: ""

redis:
  enabled: false                               # auto-enabled when enrichment.enabled
  image: redis:7-alpine
  storage:
    size: 5Gi
    storageClassName: ""
  service:
    port: 6379

neo4j:
  enabled: false                               # auto-enabled when enrichment.enabled
  image: neo4j:5-community
  auth:
    username: "neo4j"
    password: ""                               # required when enabled
  storage:
    size: 20Gi
    storageClassName: ""
  service:
    boltPort: 7687
    httpPort: 7474
  plugins: '["apoc"]'
```

### Conditional Rendering

All new templates gated on `enrichment.enabled`:

```yaml
{{- if .Values.enrichment.enabled }}
# ... redis, neo4j, worker resources ...
{{- end }}
```

The API configmap conditionally injects `REDIS_URL` when enrichment is enabled. When disabled, the API behaves exactly as it does today — no Redis dependency, no enrichment queueing.

### Deployment

```bash
# Without enrichment (current behavior)
helm install raged ./chart

# With enrichment
helm install raged ./chart \
  --set enrichment.enabled=true \
  --set neo4j.auth.password=secretpassword \
  --set enrichment.worker.extractor.provider=anthropic \
  --set enrichment.worker.extractor.anthropicApiKey=sk-...
```
