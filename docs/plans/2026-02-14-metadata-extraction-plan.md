# Metadata Extraction & Knowledge Graph — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add automatic metadata extraction during ingestion with async LLM enrichment, a Neo4j knowledge graph, and hybrid vector+graph retrieval.

**Architecture:** Ingest stays synchronous with heuristic tier-1 extraction. A Python enrichment worker pulls tasks from Redis, runs NLP (tier-2) and LLM (tier-3) extraction, updates Qdrant payloads, and writes entities/relationships to Neo4j. The LLM adapter is pluggable (Ollama, Anthropic, OpenAI).

**Tech Stack:** TypeScript (API, CLI), Python (worker), Redis (queue), Neo4j (graph), Tree-sitter (AST), sharp/exif-reader (EXIF), spaCy (NER), Fastify (HTTP)

**Design Doc:** `docs/plans/2026-02-14-metadata-extraction-design.md`

---

## Phase 1: Infrastructure

### Task 1: Add Redis, Neo4j, and worker to Docker Compose

**Files:**
- Modify: `docker-compose.yml` (currently 30 lines)

**Step 1: Add Redis service**

Add after the `ollama` service block (after line 10):

```yaml
  redis:
    image: redis:7-alpine
    ports: ["6379:6379"]
    volumes: ["redis_data:/data"]
    command: redis-server --appendonly yes
    profiles: ["enrichment", "full"]
```

**Step 2: Add Neo4j service**

```yaml
  neo4j:
    image: neo4j:5-community
    ports:
      - "7474:7474"
      - "7687:7687"
    environment:
      NEO4J_AUTH: "${NEO4J_AUTH:-}"
      NEO4J_PLUGINS: '["apoc"]'
    volumes: ["neo4j_data:/data"]
    profiles: ["enrichment", "full"]
```

**Step 3: Add enrichment worker service**

```yaml
  enrichment-worker:
    build: ./worker
    environment:
      REDIS_URL: "redis://redis:6379"
      QDRANT_URL: "http://qdrant:6333"
      NEO4J_URL: "bolt://neo4j:7687"
      NEO4J_USER: "neo4j"
      NEO4J_PASSWORD: "${NEO4J_PASSWORD}"
      OLLAMA_URL: "http://ollama:11434"
      EXTRACTOR_PROVIDER: "ollama"
      EXTRACTOR_MODEL_FAST: "llama3"
      EXTRACTOR_MODEL_CAPABLE: "llama3"
      EXTRACTOR_MODEL_VISION: "llava"
      WORKER_CONCURRENCY: "4"
    depends_on: [redis, neo4j, qdrant, ollama]
    profiles: ["enrichment", "full"]
```

**Step 4: Add REDIS_URL to api service environment**

In the `api` service environment block (after line 23), add:

```yaml
      ENRICHMENT_ENABLED: "false"
```

For enrichment runs, set `ENRICHMENT_ENABLED=true` and provide `REDIS_URL` via env/override.
Do **not** add `redis` to the base `api.depends_on`; keep API startup independent of Redis.

**Step 5: Add new volumes**

Extend the volumes block (line 28-30) to include:

```yaml
  redis_data:
  neo4j_data:
```

**Step 6: Verify**

Run: `docker compose config --profiles enrichment`
Expected: Valid YAML with all 6 services listed.

Run: `docker compose up -d` (without profile)
Expected: Only qdrant, ollama, api start (current behavior preserved).

Run: `docker compose --profile enrichment up -d`
Expected: All 6 services start (will fail on worker build — that's expected, worker doesn't exist yet).

**Step 7: Commit**

```bash
git add docker-compose.yml
git commit -m "infra: add redis, neo4j, enrichment-worker to docker compose with profiles"
```

---

### Task 2: Scaffold the Python enrichment worker

**Files:**
- Create: `worker/Dockerfile`
- Create: `worker/requirements.txt`
- Create: `worker/src/__init__.py`
- Create: `worker/src/main.py`
- Create: `worker/src/config.py`
- Create: `worker/tests/__init__.py`

**Step 1: Create worker directory and Dockerfile**

```dockerfile
# worker/Dockerfile
FROM python:3.12-slim

WORKDIR /app

# Install system dependencies for spaCy and Tree-sitter
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Download spaCy English model
RUN python -m spacy download en_core_web_sm

COPY src/ src/
COPY tests/ tests/

CMD ["python", "-m", "src.main"]
```

**Step 2: Create requirements.txt**

```
redis>=5.0,<6.0
qdrant-client>=1.10,<2.0
neo4j>=5.0,<6.0
spacy>=3.7,<4.0
pytextrank>=3.0,<4.0
langdetect>=1.0,<2.0
anthropic>=0.40,<1.0
openai>=1.50,<2.0
httpx>=0.27,<1.0
pydantic>=2.0,<3.0
pytest>=8.0,<9.0
```

**Step 3: Create config.py**

```python
# worker/src/config.py
import os

REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379")
QDRANT_URL = os.environ.get("QDRANT_URL", "http://localhost:6333")
NEO4J_URL = os.environ.get("NEO4J_URL", "bolt://localhost:7687")
NEO4J_USER = os.environ.get("NEO4J_USER", "neo4j")
NEO4J_PASSWORD = os.environ.get("NEO4J_PASSWORD", "")
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434")

EXTRACTOR_PROVIDER = os.environ.get("EXTRACTOR_PROVIDER", "ollama")
EXTRACTOR_MODEL_FAST = os.environ.get("EXTRACTOR_MODEL_FAST", "llama3")
EXTRACTOR_MODEL_CAPABLE = os.environ.get("EXTRACTOR_MODEL_CAPABLE", "llama3")
EXTRACTOR_MODEL_VISION = os.environ.get("EXTRACTOR_MODEL_VISION", "llava")

ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")

WORKER_CONCURRENCY = int(os.environ.get("WORKER_CONCURRENCY", "4"))
MAX_RETRIES = 3
QUEUE_NAME = "enrichment:pending"
DEAD_LETTER_QUEUE = "enrichment:dead-letter"

if NEO4J_URL and not NEO4J_PASSWORD:
    raise RuntimeError("NEO4J_PASSWORD environment variable must be set for Neo4j access")
```

**Step 4: Create main.py skeleton**

```python
# worker/src/main.py
import asyncio
import logging
from src.config import REDIS_URL, QUEUE_NAME, WORKER_CONCURRENCY

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
logger = logging.getLogger(__name__)

async def process_task(task_data: dict) -> None:
    """Process a single enrichment task. Implemented in later tasks."""
    logger.info(f"Processing task: {task_data.get('taskId', 'unknown')}")
    pass

async def worker_loop() -> None:
    """Main worker loop: dequeue and process tasks."""
    import redis.asyncio as aioredis
    r = aioredis.from_url(REDIS_URL)
    logger.info(f"Worker started, listening on {QUEUE_NAME}")
    while True:
        _, raw = await r.brpop(QUEUE_NAME)
        import json
        task = json.loads(raw)
        await process_task(task)

def main():
    asyncio.run(worker_loop())

if __name__ == "__main__":
    main()
```

**Step 5: Create empty __init__.py files**

Create `worker/src/__init__.py` and `worker/tests/__init__.py` as empty files.

**Step 6: Verify Docker build**

Run: `cd worker && docker build -t rag-worker:test .`
Expected: Build succeeds (spaCy model downloads may take a minute).

Run: `docker compose --profile enrichment up -d`
Expected: All 6 services start. Worker connects to Redis and waits.

**Step 7: Commit**

```bash
git add worker/
git commit -m "feat(worker): scaffold python enrichment worker with dockerfile and config"
```

---

### Task 3: Add Helm chart templates for Redis, Neo4j, and worker

**Files:**
- Modify: `chart/values.yaml` (currently 57 lines)
- Modify: `chart/templates/api-configmap.yaml` (currently 15 lines)
- Create: `chart/templates/redis-deployment.yaml`
- Create: `chart/templates/redis-service.yaml`
- Create: `chart/templates/redis-pvc.yaml`
- Create: `chart/templates/neo4j-statefulset.yaml`
- Create: `chart/templates/neo4j-service.yaml`
- Create: `chart/templates/neo4j-secret.yaml`
- Create: `chart/templates/worker-deployment.yaml`
- Create: `chart/templates/worker-configmap.yaml`

**Step 1: Add new values to `chart/values.yaml`**

Append after the ollama section (after line 57):

```yaml
enrichment:
  enabled: false
  worker:
    image:
      repository: your-registry/rag-worker
      tag: "1.0.0"
      pullPolicy: IfNotPresent
    replicas: 1
    concurrency: 4
    resources: {}
    extractor:
      provider: "ollama"
      modelFast: "llama3"
      modelCapable: "llama3"
      modelVision: "llava"
      anthropicApiKey: ""
      openaiApiKey: ""

redis:
  enabled: false
  image: redis:7-alpine
  storage:
    size: 5Gi
    storageClassName: ""
  service:
    port: 6379

neo4j:
  enabled: false
  image: neo4j:5-community
  auth:
    username: "neo4j"
    password: ""
  storage:
    size: 20Gi
    storageClassName: ""
  service:
    boltPort: 7687
    httpPort: 7474
  plugins: '["apoc"]'
```

**Step 2: Create Redis templates**

All Redis templates gated on `{{- if or .Values.redis.enabled .Values.enrichment.enabled }}`.

`redis-deployment.yaml`: Standard Deployment with redis:7-alpine, port 6379, `redis-server --appendonly yes` command, PVC mount at `/data`.

`redis-service.yaml`: ClusterIP service on `{{ .Values.redis.service.port }}`.

`redis-pvc.yaml`: PVC with `{{ .Values.redis.storage.size }}`, optional storageClassName.

Follow the same patterns as existing templates (e.g., `qdrant-statefulset.yaml` for naming conventions, label patterns, `_helpers.tpl` usage).

**Step 3: Create Neo4j templates**

All gated on `{{- if or .Values.neo4j.enabled .Values.enrichment.enabled }}`.

`neo4j-statefulset.yaml`: StatefulSet (like qdrant), neo4j:5-community image, ports 7474 + 7687, env from secret for auth, APOC plugin config, PVC for `/data`.

`neo4j-service.yaml`: ClusterIP with both bolt (7687) and HTTP (7474) ports.

`neo4j-secret.yaml`: Secret containing `NEO4J_AUTH` as `username/password`. Gated on password being non-empty.

**Step 4: Create worker templates**

All gated on `{{- if .Values.enrichment.enabled }}`.

`worker-deployment.yaml`: Deployment with configurable replicas, image from values, env from configmap. No service needed (worker is a consumer, not a server).

`worker-configmap.yaml`: ConfigMap with all worker environment variables:
- `REDIS_URL`: pointing to `{{ .Release.Name }}-redis:{{ .Values.redis.service.port }}`
- `QDRANT_URL`: pointing to `{{ .Release.Name }}-qdrant:{{ .Values.qdrant.service.port }}`
- `NEO4J_URL`: pointing to `{{ .Release.Name }}-neo4j:{{ .Values.neo4j.service.boltPort }}`
- `NEO4J_USER`, `NEO4J_PASSWORD` from secret ref
- `OLLAMA_URL`: pointing to `{{ .Release.Name }}-ollama:{{ .Values.ollama.service.port }}`
- Extractor settings from values

**Step 5: Update api-configmap.yaml**

Add conditional `REDIS_URL` when enrichment is enabled:

```yaml
  {{- if .Values.enrichment.enabled }}
  REDIS_URL: "redis://{{ .Release.Name }}-redis:{{ .Values.redis.service.port }}"
  ENRICHMENT_ENABLED: "true"
  {{- end }}
```

**Step 6: Verify**

Run: `helm template test-release ./chart` — should render without enrichment resources.

Run: `helm template test-release ./chart --set enrichment.enabled=true --set neo4j.auth.password=test` — should render all enrichment resources.

**Step 7: Commit**

```bash
git add chart/
git commit -m "infra(helm): add redis, neo4j, worker templates gated on enrichment.enabled"
```

---

## Phase 2: Document Type Detection & Tier-1 Extraction

### Task 4: Document type detection module in API

**Files:**
- Create: `api/src/doctype.ts`
- Create: `api/src/doctype.test.ts`

**Step 1: Write failing tests**

Test cases for `detectDocType(item)`:
- Explicit `docType` field passes through: `{ docType: "slack" }` → `"slack"`
- Metadata hint `channel` → `"slack"`
- Metadata hint `from` + `subject` → `"email"`
- Source URL `github.com` → `"code"`
- File extension `.py` → `"code"`, `.pdf` → `"pdf"`, `.png` → `"image"`
- Content sniffing: string starting with `From:` or `Subject:` → `"email"`
- Content with JSON `{"messages":[` → `"slack"`
- Fallback → `"text"`

Run tests with: `cd api && npx tsx --test src/doctype.test.ts`

**Step 2: Implement `detectDocType`**

```typescript
// api/src/doctype.ts
export type DocType = "code" | "slack" | "email" | "meeting" | "pdf" | "image" | "article" | "text";

export interface IngestItem {
  id?: string;
  text: string;
  source: string;
  docType?: DocType;
  metadata?: Record<string, unknown>;
}

export function detectDocType(item: IngestItem): DocType {
  // 1. Explicit
  if (item.docType) return item.docType;
  // 2. Metadata hints
  // 3. Source URL patterns
  // 4. Content sniffing
  // 5. File extension from source
  // 6. Fallback
  return "text";
}
```

Detection priority order:
1. `item.docType` if provided
2. Metadata field presence: `channel`/`threadId` → slack, `from`+`subject` → email
3. Source URL: `github.com`/`gitlab.com` → code, `slack.com` → slack
4. Content sniffing: RFC 2822 headers → email, `{"messages":[` → slack
5. File extension from `item.source`: code extensions → code, `.pdf` → pdf, image extensions → image, `.md`/`.html` → article
6. Fallback: `"text"`

**Step 3: Run tests, verify pass**

**Step 4: Commit**

```bash
git add api/src/doctype.ts api/src/doctype.test.ts
git commit -m "feat(api): add document type auto-detection"
```

---

### Task 5: Tier-1 metadata extractors

**Files:**
- Create: `api/src/extractors/index.ts`
- Create: `api/src/extractors/code.ts`
- Create: `api/src/extractors/email.ts`
- Create: `api/src/extractors/slack.ts`
- Create: `api/src/extractors/image.ts`
- Create: `api/src/extractors/meeting.ts`
- Create: `api/src/extractors/article.ts`
- Create: `api/src/extractors/pdf.ts`
- Create: `api/src/extractors/extractors.test.ts`
- Modify: `api/package.json` (add dependencies)

Each extractor is a pure function: `extractTier1(item: IngestItem): Record<string, unknown>`.

**Step 1: Install dependencies**

```bash
cd api && npm install tree-sitter tree-sitter-typescript tree-sitter-javascript tree-sitter-python tree-sitter-go tree-sitter-rust sharp exif-reader
```

Tree-sitter provides AST parsing for code. sharp/exif-reader for image EXIF.

**Step 2: Write failing tests for each extractor**

Test file `api/src/extractors/extractors.test.ts` with test cases:

- **code**: TypeScript input → extracts `functions[]`, `classes[]`, `imports[]`, `exports[]`
- **email**: Raw email with headers → extracts `from`, `to`, `cc`, `subject`, `date`, `messageId`, `inReplyTo`
- **slack**: JSON message → extracts `channel`, `threadId`, `participants`, `timestamp`
- **image**: EXIF-bearing JPEG buffer → extracts `mimeType`, `dimensions`, `exif.gps`, `exif.dateTaken`, `exif.camera`
- **meeting**: Transcript text → extracts `date`, `participants` (regex: "Attendees: ...")
- **article**: HTML with OG tags → extracts `title`, `author`, `publishDate`
- **pdf**: Metadata object → extracts `title`, `author`, `pageCount`

**Step 3: Implement each extractor**

- `code.ts`: Use Tree-sitter to parse source, walk AST for function declarations, class declarations, import statements, export statements. Use `extToLang` mapping from `cli/src/index.ts:48-59` (import or duplicate the map). Return `{ lang, functions, classes, imports, exports }`.

- `email.ts`: Regex-based RFC 2822 header parser. Split on first blank line for headers vs body. Extract `From`, `To`, `Cc`, `Subject`, `Date`, `Message-ID`, `In-Reply-To`, `References`. Return structured object.

- `slack.ts`: Parse JSON if text is JSON. Look for `channel`, `thread_ts` (→ `threadId`), `user`/`username` fields, `ts` (→ `timestamp`). For Slack export format, iterate messages to collect participants.

- `image.ts`: Use `sharp` to get dimensions and metadata. Use `exif-reader` to parse EXIF data. Extract GPS coordinates (convert from DMS to decimal), date taken (`DateTimeOriginal`), camera model (`Make` + `Model`), orientation. For non-JPEG/non-EXIF images, return just `mimeType` and `dimensions`.

- `meeting.ts`: Regex patterns for "Date:", "Duration:", "Attendees:", "Platform:" in meeting note headers. Also detect Zoom/Teams/Meet transcript formats.

- `article.ts`: Regex for `<meta property="og:title"`, `og:author`, `article:published_time`. Also parse `<title>`, `<meta name="author">`. For markdown, extract YAML frontmatter.

- `pdf.ts`: PDF metadata is caller-provided (the API receives text, not binary). Extract from `item.metadata` fields `title`, `author`, `pageCount`, `createdDate` if present. The CLI `ingest` command (Task 10) will be responsible for parsing PDF binary and passing metadata.

- `index.ts`: Router function that dispatches to the correct extractor based on `docType`:

```typescript
export function extractTier1(item: IngestItem, docType: DocType): Record<string, unknown> {
  switch (docType) {
    case "code": return extractCode(item);
    case "email": return extractEmail(item);
    case "slack": return extractSlack(item);
    case "image": return extractImage(item);
    case "meeting": return extractMeeting(item);
    case "article": return extractArticle(item);
    case "pdf": return extractPdf(item);
    default: return {};
  }
}
```

**Step 4: Run tests, verify pass**

**Step 5: Commit**

```bash
git add api/src/extractors/ api/package.json api/package-lock.json
git commit -m "feat(api): add tier-1 metadata extractors for all document types"
```

---

### Task 6: Integrate detection + tier-1 extraction into `/ingest`

**Files:**
- Modify: `api/src/server.ts:13-33` (the `/ingest` handler)

**Step 1: Write failing integration test**

Create `api/src/server.test.ts` (or extend if exists). Test that `POST /ingest` with a code file returns `enrichmentStatus: "pending"` and `docType: "code"` in the response. Test that `enrich: false` skips queue.

**Step 2: Update the ingest handler**

Current flow (lines 13-33):
```
items → chunkText → embed → upsert
```

New flow:
```
items → detectDocType → extractTier1 → chunkText → embed → upsert (with enriched payload) → enqueue to Redis
```

Changes to the ingest handler in `server.ts`:

1. Import `detectDocType`, `extractTier1` from new modules
2. For each item, call `detectDocType(item)` and `extractTier1(item, docType)`
3. Add to each point's payload: `docType`, `ingestedAt` (ISO timestamp), `enrichmentStatus: "pending"`, `tier1Meta: { ...extracted }`
4. After upsert, if `req.body.enrich !== false` and Redis is configured, push tasks to Redis queue
5. Update response to include `enrichment: { enqueued, docTypes }` field

**Step 3: Redis client setup**

Create `api/src/redis.ts`:

```typescript
import { createClient } from "redis";

const REDIS_URL = process.env.REDIS_URL || "";
const ENRICHMENT_ENABLED = process.env.ENRICHMENT_ENABLED === "true";

let client: ReturnType<typeof createClient> | null = null;

export async function getRedisClient() {
  if (!ENRICHMENT_ENABLED || !REDIS_URL) return null;
  if (!client) {
    client = createClient({ url: REDIS_URL });
    await client.connect();
  }
  return client;
}

export async function enqueueEnrichment(tasks: object[]) {
  const redis = await getRedisClient();
  if (!redis) return 0;
  for (const task of tasks) {
    await redis.lPush("enrichment:pending", JSON.stringify(task));
  }
  return tasks.length;
}
```

Install: `cd api && npm install redis`

**Step 4: Verify backwards compatibility**

Run existing tests. Run `docker compose up -d` (without enrichment profile). Verify `/ingest` still works without Redis. The `enqueueEnrichment` should gracefully return 0 when Redis is not configured.

**Step 5: Commit**

```bash
git add api/src/server.ts api/src/redis.ts api/package.json api/package-lock.json
git commit -m "feat(api): integrate doctype detection, tier-1 extraction, and redis queue into /ingest"
```

---

## Phase 3: Enrichment Worker

### Task 7: Tier-2 NLP extraction in worker

**Files:**
- Create: `worker/src/tier2.py`
- Create: `worker/tests/test_tier2.py`

**Step 1: Write failing tests**

Test cases:
- `extract_entities(text)` → returns list of `{text, label}` dicts (PERSON, ORG, etc.)
- `extract_keywords(text)` → returns list of top keywords/phrases
- `detect_language(text)` → returns ISO language code

**Step 2: Implement tier-2 extractors**

```python
# worker/src/tier2.py
import spacy

nlp = spacy.load("en_core_web_sm")

def extract_entities(text: str) -> list[dict]:
    doc = nlp(text)
    return [{"text": ent.text, "label": ent.label_} for ent in doc.ents]

def extract_keywords(text: str, top_n: int = 10) -> list[str]:
    # Use pytextrank for keyphrase extraction
    import pytextrank
    if "textrank" not in nlp.pipe_names:
        nlp.add_pipe("textrank")
    doc = nlp(text)
    return [phrase.text for phrase in doc._.phrases[:top_n]]

def detect_language(text: str) -> str:
    from langdetect import detect, DetectorFactory
    DetectorFactory.seed = 0

    normalized = text.replace("\n", " ").strip()
    if not normalized:
        return "unknown"

    try:
        return detect(normalized)
    except Exception:
        return "unknown"
```

**Step 3: Run tests**

Run: `cd worker && python -m pytest tests/test_tier2.py -v`

**Step 4: Commit**

```bash
git add worker/src/tier2.py worker/tests/test_tier2.py
git commit -m "feat(worker): add tier-2 NLP extraction (entities, keywords, language)"
```

---

### Task 8: Pluggable LLM adapter

**Files:**
- Create: `worker/src/adapters/__init__.py`
- Create: `worker/src/adapters/base.py`
- Create: `worker/src/adapters/ollama.py`
- Create: `worker/src/adapters/anthropic.py`
- Create: `worker/src/adapters/openai.py`
- Create: `worker/tests/test_adapters.py`

**Step 1: Define the base adapter interface**

```python
# worker/src/adapters/base.py
from abc import ABC, abstractmethod
from pydantic import BaseModel

class ExtractionResult(BaseModel):
    metadata: dict
    entities: list[dict] = []
    relationships: list[dict] = []

class ImageDescription(BaseModel):
    description: str
    detected_objects: list[str] = []
    ocr_text: str = ""
    image_type: str = ""  # photo, diagram, screenshot, chart

class ExtractorAdapter(ABC):
    @abstractmethod
    async def extract_metadata(self, text: str, doc_type: str, schema: dict) -> dict:
        """Extract type-specific metadata using the fast model."""
        ...

    @abstractmethod
    async def extract_entities(self, text: str) -> dict:
        """Extract entities and relationships using the capable model."""
        ...

    @abstractmethod
    async def describe_image(self, image_base64: str, context: str = "") -> ImageDescription:
        """Describe an image using the vision model."""
        ...

    @abstractmethod
    async def is_available(self) -> bool:
        """Check if the provider is reachable."""
        ...
```

**Step 2: Implement Ollama adapter**

`worker/src/adapters/ollama.py`: Uses `httpx` to call Ollama's `/api/generate` endpoint with JSON mode. Constructs prompts per doc type with the schema. Parses and validates JSON response. Falls back to re-prompting on invalid JSON.

**Step 3: Implement Anthropic adapter**

`worker/src/adapters/anthropic.py`: Uses `anthropic` SDK. Uses `tool_use` with JSON schema for structured output. Smart routing: `EXTRACTOR_MODEL_FAST` for metadata, `EXTRACTOR_MODEL_CAPABLE` for entities/relationships, vision model for images.

**Step 4: Implement OpenAI adapter**

`worker/src/adapters/openai.py`: Uses `openai` SDK. Uses `response_format` with JSON schema. Same smart routing pattern.

**Step 5: Factory function**

```python
# worker/src/adapters/__init__.py
from src.config import EXTRACTOR_PROVIDER

def get_adapter() -> ExtractorAdapter:
    if EXTRACTOR_PROVIDER == "anthropic":
        from src.adapters.anthropic import AnthropicAdapter
        return AnthropicAdapter()
    elif EXTRACTOR_PROVIDER == "openai":
        from src.adapters.openai import OpenAIAdapter
        return OpenAIAdapter()
    else:
        from src.adapters.ollama import OllamaAdapter
        return OllamaAdapter()
```

**Step 6: Write tests**

Test the Ollama adapter against a running Ollama instance (integration test). Mock tests for Anthropic/OpenAI adapters that verify the correct API calls and schema handling.

**Step 7: Commit**

```bash
git add worker/src/adapters/ worker/tests/test_adapters.py
git commit -m "feat(worker): add pluggable LLM adapter (ollama, anthropic, openai)"
```

---

### Task 9: Tier-3 LLM extraction schemas

**Files:**
- Create: `worker/src/schemas/__init__.py`
- Create: `worker/src/schemas/code.py`
- Create: `worker/src/schemas/slack.py`
- Create: `worker/src/schemas/email.py`
- Create: `worker/src/schemas/meeting.py`
- Create: `worker/src/schemas/image.py`
- Create: `worker/src/schemas/pdf.py`
- Create: `worker/src/schemas/article.py`
- Create: `worker/src/schemas/entities.py`
- Create: `worker/tests/test_schemas.py`

**Step 1: Define Pydantic schemas per doc type**

Each schema defines the structured output the LLM should produce, plus the prompt template.

Example for code:

```python
# worker/src/schemas/code.py
from pydantic import BaseModel

class CodeMetadata(BaseModel):
    summary: str
    purpose: str
    complexity: str  # low, medium, high

PROMPT = """Analyze this code and extract:
- summary: A 1-2 sentence summary of what this code does
- purpose: The purpose of this code in the broader system
- complexity: Rate as "low", "medium", or "high"

Code:
{text}

Respond with valid JSON matching this schema: {schema}"""
```

Similar schemas for each doc type as defined in the design doc (Section 3: Tier-3 Extraction table).

**Step 2: Entity/relationship extraction schema**

```python
# worker/src/schemas/entities.py
from pydantic import BaseModel

class Entity(BaseModel):
    name: str
    type: str  # person, class, concept, project, org, etc.
    description: str

class Relationship(BaseModel):
    source: str  # entity name
    target: str  # entity name
    type: str    # uses, depends-on, discusses, etc.
    description: str = ""

class EntityExtractionResult(BaseModel):
    entities: list[Entity]
    relationships: list[Relationship]
```

**Step 3: Schema router**

```python
# worker/src/schemas/__init__.py
def get_schema_for_doctype(doc_type: str) -> tuple[type[BaseModel], str]:
    """Returns (schema_class, prompt_template) for the given doc type."""
    ...
```

**Step 4: Tests**

Validate that each schema can be instantiated with sample data and serialized to JSON. Verify prompt templates include `{text}` and `{schema}` placeholders.

**Step 5: Commit**

```bash
git add worker/src/schemas/ worker/tests/test_schemas.py
git commit -m "feat(worker): add per-doctype LLM extraction schemas and prompts"
```

---

### Task 10: Neo4j client and graph operations

**Files:**
- Create: `worker/src/graph.py`
- Create: `worker/tests/test_graph.py`

**Step 1: Write failing tests**

Test cases (using a test Neo4j instance or mocks):
- `upsert_entity(entity)` → creates or updates an Entity node
- `upsert_document(doc)` → creates a Document node
- `add_mention(doc_id, entity_name)` → creates MENTIONS edge
- `add_relationship(source, target, rel_type)` → creates RELATES_TO edge
- `get_entity_neighborhood(name, depth)` → returns connected entities and documents

**Step 2: Implement graph client**

```python
# worker/src/graph.py
from neo4j import AsyncGraphDatabase
from src.config import NEO4J_URL, NEO4J_USER, NEO4J_PASSWORD

driver = AsyncGraphDatabase.driver(NEO4J_URL, auth=(NEO4J_USER, NEO4J_PASSWORD))

async def upsert_entity(name: str, entity_type: str, description: str) -> None:
    async with driver.session() as session:
        await session.run("""
            MERGE (e:Entity {name: $name})
            SET e.type = $type, e.description = $description,
                e.lastSeen = datetime(), e.mentionCount = coalesce(e.mentionCount, 0) + 1
            ON CREATE SET e.firstSeen = datetime()
        """, name=name, type=entity_type, description=description)

async def upsert_document(doc_id: str, doc_type: str, source: str, collection: str, summary: str = "") -> None:
    async with driver.session() as session:
        await session.run("""
            MERGE (d:Document {id: $id})
            SET d.docType = $docType, d.source = $source,
                d.collection = $collection, d.summary = $summary,
                d.ingestedAt = datetime()
        """, id=doc_id, docType=doc_type, source=source, collection=collection, summary=summary)

async def add_mention(doc_id: str, entity_name: str) -> None:
    async with driver.session() as session:
        await session.run("""
            MATCH (d:Document {id: $docId})
            MATCH (e:Entity {name: $entityName})
            MERGE (d)-[:MENTIONS]->(e)
        """, docId=doc_id, entityName=entity_name)

async def add_relationship(source: str, target: str, rel_type: str, description: str = "") -> None:
    async with driver.session() as session:
        await session.run("""
            MERGE (s:Entity {name: $source})
            MERGE (t:Entity {name: $target})
            MERGE (s)-[r:RELATES_TO]->(t)
            SET r.type = $type, r.description = $description
        """, source=source, target=target, type=rel_type, description=description)

async def get_entity_neighborhood(name: str, depth: int = 2) -> dict:
    async with driver.session() as session:
        result = await session.run("""
            MATCH (e:Entity {name: $name})
            OPTIONAL MATCH (e)-[r*1..$depth]-(connected)
            OPTIONAL MATCH (d:Document)-[:MENTIONS]->(e)
            RETURN e, collect(DISTINCT connected) as connections, collect(DISTINCT d) as documents
        """, name=name, depth=depth)
        # Parse and return structured result
        ...
```

**Step 3: Run tests**

Run: `cd worker && python -m pytest tests/test_graph.py -v`

Requires Neo4j running: `docker compose --profile enrichment up neo4j -d`

**Step 4: Commit**

```bash
git add worker/src/graph.py worker/tests/test_graph.py
git commit -m "feat(worker): add neo4j graph client for entity and relationship storage"
```

---

### Task 11: Complete worker processing pipeline

**Files:**
- Modify: `worker/src/main.py`
- Create: `worker/src/pipeline.py`
- Create: `worker/tests/test_pipeline.py`

**Step 1: Implement the pipeline**

```python
# worker/src/pipeline.py
import json
import logging
from qdrant_client import QdrantClient
from src.config import QDRANT_URL, MAX_RETRIES
from src.tier2 import extract_entities as nlp_entities, extract_keywords, detect_language
from src.adapters import get_adapter
from src.schemas import get_schema_for_doctype
from src.schemas.entities import EntityExtractionResult
from src import graph

logger = logging.getLogger(__name__)
qdrant = QdrantClient(url=QDRANT_URL)
adapter = get_adapter()

async def process_task(task: dict) -> None:
    """Full enrichment pipeline for one task."""
    base_id = task["baseId"]
    collection = task["collection"]
    doc_type = task["docType"]
    text = task["text"]
    chunk_index = task["chunkIndex"]
    total_chunks = task["totalChunks"]

    # Update status to processing
    update_enrichment_status(task["qdrantId"], collection, "processing")

    # Tier 2: NLP (per-chunk)
    tier2 = {}
    try:
        tier2["entities"] = nlp_entities(text)
        tier2["keywords"] = extract_keywords(text)
        tier2["language"] = detect_language(text)
    except Exception as e:
        logger.warning(f"Tier-2 failed for {base_id}:{chunk_index}: {e}")

    # Update Qdrant with tier-2 results
    update_payload(task["qdrantId"], collection, {"tier2": tier2})

    # Tier 3: LLM (document-level — only trigger on last chunk)
    if chunk_index == total_chunks - 1:
        await run_document_level_extraction(base_id, collection, doc_type, total_chunks)

    # Mark chunk as enriched
    update_enrichment_status(task["qdrantId"], collection, "enriched")

async def run_document_level_extraction(base_id: str, collection: str, doc_type: str, total_chunks: int) -> None:
    """Aggregate all chunks and run tier-3 LLM extraction."""
    # Read all chunks for this document from Qdrant
    full_text = aggregate_chunks(base_id, collection, total_chunks)

    # Type-specific metadata extraction
    schema_cls, prompt_template = get_schema_for_doctype(doc_type)
    tier3_meta = await adapter.extract_metadata(full_text, doc_type, schema_cls.model_json_schema())

    # Entity + relationship extraction
    entity_result = await adapter.extract_entities(full_text)

    # Update all chunks with tier-3 results
    for i in range(total_chunks):
        update_payload(f"{base_id}:{i}", collection, {"tier3": tier3_meta})

    # Write to Neo4j
    source = get_source_from_qdrant(base_id, collection)
    await graph.upsert_document(base_id, doc_type, source, collection, tier3_meta.get("summary", ""))

    for entity in entity_result.get("entities", []):
        await graph.upsert_entity(entity["name"], entity["type"], entity.get("description", ""))
        await graph.add_mention(base_id, entity["name"])

    for rel in entity_result.get("relationships", []):
        await graph.add_relationship(rel["source"], rel["target"], rel["type"], rel.get("description", ""))
```

**Step 2: Update main.py worker loop**

Update `worker/src/main.py` to use the pipeline, add concurrency (asyncio semaphore), retry logic, and dead-letter handling:

- On task failure, increment `attempt` and re-push to queue if `attempt < MAX_RETRIES`
- After MAX_RETRIES, push to dead-letter queue
- Use `asyncio.Semaphore(WORKER_CONCURRENCY)` for concurrency control
- Add structured JSON logging for each task completion

**Step 3: Write integration test**

Test the full pipeline with a mock LLM adapter, real Qdrant, and real Neo4j. Verify:
- Qdrant payload gets updated with tier-2 and tier-3 results
- Neo4j gets entities and relationships
- `enrichmentStatus` transitions: pending → processing → enriched

**Step 4: Commit**

```bash
git add worker/src/pipeline.py worker/src/main.py worker/tests/test_pipeline.py
git commit -m "feat(worker): complete enrichment pipeline with tier-2, tier-3, and graph writes"
```

---

## Phase 4: API Enhancements

### Task 12: New API endpoints

**Files:**
- Modify: `api/src/server.ts`
- Create: `api/src/graph-client.ts`

**Step 1: Add `GET /enrichment/status/:baseId`**

Query Qdrant for all chunks matching the baseId, aggregate enrichment status. Return:

```json
{
  "baseId": "...",
  "status": "enriched|processing|pending|failed",
  "chunks": { "total": 3, "enriched": 3, "pending": 0, "failed": 0 },
  "metadata": { "tier2": {...}, "tier3": {...} }
}
```

**Step 2: Add `GET /enrichment/stats`**

Query Redis for queue lengths (`LLEN enrichment:pending`, `LLEN enrichment:dead-letter`). Query Qdrant for counts by `enrichmentStatus`. Return stats object.

**Step 3: Add `POST /enrichment/enqueue`**

Accepts `{ collection, force }`. Scans Qdrant for items where `enrichmentStatus != "enriched"` (or all items if `force: true`). Pushes them to Redis queue. Returns count enqueued.

**Step 4: Add `graphExpand` to `POST /query`**

In the existing query handler (`server.ts:35-46`):
1. If `req.body.graphExpand` is true and Neo4j is configured:
2. After vector search, extract entity names from results
3. Call Neo4j to expand 1-2 hops
4. Fetch connected documents from Qdrant
5. Merge, deduplicate, re-rank
6. Add `graph` field to response

Requires a Neo4j client for the API. Create `api/src/graph-client.ts`:

```typescript
import neo4j from "neo4j-driver";

const NEO4J_URL = process.env.NEO4J_URL || "";
const NEO4J_USER = process.env.NEO4J_USER || "";
const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD || "";
const driver = NEO4J_URL && NEO4J_USER && NEO4J_PASSWORD
  ? neo4j.driver(NEO4J_URL, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD))
  : null;

export async function expandEntities(entityNames: string[], depth = 2) {
  if (!driver || entityNames.length === 0) return [];
  const session = driver.session();
  try {
    const result = await session.run(
      `
      MATCH (e:Entity)
      WHERE e.name IN $entityNames
      MATCH path = (e)-[:RELATES_TO*1..$depth]-(neighbor:Entity)
      RETURN DISTINCT neighbor.name AS name, neighbor.type AS type
      LIMIT 200
      `,
      { entityNames, depth }
    );
    return result.records.map((record) => ({
      name: record.get("name"),
      type: record.get("type"),
    }));
  } finally {
    await session.close();
  }
}

export async function getEntity(name: string) {
  if (!driver) return null;
  const session = driver.session();
  try {
    const result = await session.run(
      `
      MATCH (e:Entity {name: $name})
      OPTIONAL MATCH (e)-[r:RELATES_TO]-(neighbor:Entity)
      RETURN e, collect(DISTINCT {
        entity: neighbor.name,
        relationship: r.type,
        direction: CASE WHEN startNode(r) = e THEN "outgoing" ELSE "incoming" END
      }) AS connections
      LIMIT 1
      `,
      { name }
    );
    if (result.records.length === 0) return null;
    const record = result.records[0];
    return {
      entity: record.get("e").properties,
      connections: record.get("connections"),
    };
  } finally {
    await session.close();
  }
}
```

Install: `cd api && npm install neo4j-driver`

**Step 5: Add `GET /graph/entity/:name`**

Query Neo4j for entity and its neighborhood. Return entity, connections, and documents.

**Step 6: Write tests for each new endpoint**

**Step 7: Commit**

```bash
git add api/src/server.ts api/src/graph-client.ts api/package.json api/package-lock.json
git commit -m "feat(api): add enrichment status, stats, enqueue, graph expand, and entity endpoints"
```

---

## Phase 5: CLI Enhancements

### Task 13: Add `rag-index ingest` command

**Files:**
- Modify: `cli/src/index.ts`
- Modify: `cli/package.json` (add dependencies for PDF/image reading)

**Step 1: Install dependencies**

```bash
cd cli && npm install commander pdf-parse sharp
```

Note: the CLI currently uses `minimist` for arg parsing. Since we're adding multiple new commands, consider migrating to `commander`. If already migrated, add subcommands. If not, add the new commands with the existing pattern.

**Step 2: Implement `cmdIngest` function**

Accepts `--file` or `--dir`. For each file:
1. Read file contents (text for text files, base64 for images, pdf-parse for PDFs)
2. Auto-detect doc type from extension/content
3. For PDFs: extract text via pdf-parse, pass PDF metadata (title, author, pageCount) in `metadata`
4. For images: read binary, base64-encode for the `text` field (worker will handle vision), pass EXIF in metadata
5. POST to `/ingest` with appropriate `docType` and metadata

**Step 3: Write tests**

Test with a sample text file, a sample PDF, and a sample image.

**Step 4: Commit**

```bash
git add cli/src/index.ts cli/package.json cli/package-lock.json
git commit -m "feat(cli): add ingest command for arbitrary file ingestion"
```

---

### Task 14: Add `rag-index enrich` command

**Files:**
- Modify: `cli/src/index.ts`

**Step 1: Implement `cmdEnrich` function**

Calls `POST /enrichment/enqueue` with collection and force options.
Calls `GET /enrichment/stats` for `--show-failed`.
Implements `--retry-failed` (calls a new endpoint or directly manipulates via API).

**Step 2: Commit**

```bash
git add cli/src/index.ts
git commit -m "feat(cli): add enrich command for triggering and monitoring enrichment"
```

---

### Task 15: Add `rag-index graph` command

**Files:**
- Modify: `cli/src/index.ts`

**Step 1: Implement `cmdGraph` function**

Calls `GET /graph/entity/:name` with optional `--depth` parameter. Formats output showing entity, connections, and related documents.

**Step 2: Commit**

```bash
git add cli/src/index.ts
git commit -m "feat(cli): add graph command for entity lookup"
```

---

### Task 16: Add `--enrich` / `--no-enrich` / `--doc-type` flags to existing commands

**Files:**
- Modify: `cli/src/index.ts`

**Step 1: Update `cmdIndex`**

Add `--enrich` (default true), `--no-enrich`, `--doc-type` flags. Pass `enrich` and `docType` to the `/ingest` API call. Update the `ingest()` helper function to accept and forward these new fields.

**Step 2: Commit**

```bash
git add cli/src/index.ts
git commit -m "feat(cli): add --enrich and --doc-type flags to index command"
```

---

## Phase 6: Documentation & Skill Updates

### Task 17: Update API reference

**Files:**
- Modify: `docs/09-api-reference.md`

Add documentation for all new endpoints: `/enrichment/status/:baseId`, `/enrichment/stats`, `/enrichment/enqueue`, `/graph/entity/:name`, and the `graphExpand`/`enrich`/`docType` parameters on existing endpoints.

**Step 1: Commit**

```bash
git add docs/09-api-reference.md
git commit -m "docs: update API reference with enrichment and graph endpoints"
```

---

### Task 18: Update CLI docs

**Files:**
- Modify: `docs/03-cli.md`

Add documentation for `rag-index ingest`, `rag-index enrich`, `rag-index graph` commands and the new flags on `rag-index index`.

**Step 1: Commit**

```bash
git add docs/03-cli.md
git commit -m "docs: update CLI reference with ingest, enrich, and graph commands"
```

---

### Task 19: Update architecture and vision docs

**Files:**
- Modify: `docs/00-vision.md`
- Modify: `docs/01-architecture.md`

Update architecture diagrams to include Redis, Neo4j, and enrichment worker. Update the roadmap to reflect that metadata extraction and graph layer are now implemented (moving items from v1.0/v2.0 planned to completed).

**Step 1: Commit**

```bash
git add docs/00-vision.md docs/01-architecture.md
git commit -m "docs: update architecture and vision with enrichment pipeline and graph layer"
```

---

### Task 20: Update skill files

**Files:**
- Modify: `skill/SKILL.md`
- Modify: `skill/skills/rag-stack/SKILL.md`

Update the skill definitions to document the new capabilities: enrichment status checking, graph queries, `--enrich` and `--doc-type` flags, `rag-index ingest` for non-repo content.

**Step 1: Commit**

```bash
git add skill/
git commit -m "docs: update rag-stack skills with enrichment and graph capabilities"
```

---

## Task Dependency Graph

```
Phase 1 (Infrastructure):
  Task 1 (Docker Compose) ─┐
  Task 2 (Worker scaffold) ─┤─→ Phase 3 (Worker)
  Task 3 (Helm chart) ──────┘

Phase 2 (Detection + Tier-1):
  Task 4 (DocType detection) ─→ Task 5 (Tier-1 extractors) ─→ Task 6 (Integrate into /ingest)

Phase 3 (Worker):
  Task 7 (Tier-2 NLP) ──────────┐
  Task 8 (LLM adapter) ─────────┤
  Task 9 (Tier-3 schemas) ──────┤─→ Task 11 (Complete pipeline)
  Task 10 (Neo4j client) ───────┘

Phase 4 (API): Task 12 (New endpoints) ← depends on Phase 2 + Phase 3

Phase 5 (CLI): Tasks 13-16 ← depends on Phase 4

Phase 6 (Docs): Tasks 17-20 ← depends on Phase 5
```

**Parallelizable:** Phase 1 + Phase 2 can run in parallel. Within Phase 3, Tasks 7-10 are independent and can run in parallel.
