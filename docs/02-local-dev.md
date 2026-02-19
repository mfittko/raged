# Local Development

Run the full raged locally using Docker Compose. No cloud services required.

## Startup

```mermaid
sequenceDiagram
    participant U as Developer
    participant DC as Docker Compose
    participant PG as Postgres
    participant API as RAG API
    participant WK as Worker

    U->>DC: docker compose up -d
    DC->>PG: Start (port 5432)
    DC->>API: Start (port 8080)
    API->>PG: Connect
    API->>API: Use OpenAI embeddings by default
    
    Note over U,WK: For enrichment stack:
    U->>DC: docker compose --profile enrichment up -d
    DC->>WK: Start enrichment worker
    WK->>PG: Poll for tasks using SKIP LOCKED
    
    U->>API: curl /healthz
    API-->>U: { ok: true }
    U->>OL: Pull nomic-embed-text
    OL-->>U: Model ready
```

## Steps

### Base Stack (Vector Search Only)

```bash
# 1. Start core services (Postgres, API)
docker compose up -d

# 2. Verify the API is running
curl -s http://localhost:8080/healthz
# → {"ok":true}

# 3. Ensure OPENAI_API_KEY is configured in .env
grep -n '^OPENAI_API_KEY=' .env
```

### Full Stack (with Enrichment & Knowledge Graph)

```bash
# 1. Start all services including enrichment worker
docker compose --profile enrichment up -d

# 2. Verify the API is running
curl -s http://localhost:8080/healthz
# → {"ok":true}

# 3. Verify enrichment is enabled
curl -s http://localhost:8080/enrichment/stats
# → {"queue":{"pending":0,...},"totals":{...}}

# Optional: run Ollama only when needed
docker compose --profile ollama up -d ollama
```

## Services

### Base Stack

| Service | Port | Purpose |
|---------|------|---------|
| `api` | 8080 | RAG API (Fastify) |
| `postgres` | 5432 | Vector database (with pgvector extension) |

### Enrichment Stack (--profile enrichment)

| Service | Port | Purpose |
|---------|------|---------|
| `enrichment-worker` | - | Python enrichment worker (background service) |

## Optional: Enable Auth Locally

Set `RAGED_API_TOKEN` in `docker-compose.yml` under the `api` service:

```yaml
environment:
  RAGED_API_TOKEN: "my-dev-token"
```

Then pass `--token my-dev-token` to CLI commands (or set `RAGED_API_TOKEN` env var).

## Optional: Configure Enrichment

Enrichment is enabled via Docker Compose profiles. To customize enrichment behavior, set environment variables in `docker-compose.yml`:

**API service:**
```yaml
environment:
  ENRICHMENT_ENABLED: "true"  # Enable enrichment features
  DATABASE_URL: "postgresql://raged:password@postgres:5432/raged"  # Postgres connection
```

**Worker service:**
```yaml
environment:
  DATABASE_URL: "postgresql://raged:password@postgres:5432/raged"
  WORKER_CONCURRENCY: "4"  # Number of concurrent tasks
  EXTRACTOR_PROVIDER: "openai"  # openai, anthropic, or ollama
  OPENAI_BASE_URL: "https://api.openai.com/v1"  # Any OpenAI-compatible /v1 endpoint
  OPENAI_API_KEY: ""  # Required for OpenAI cloud
  EXTRACTOR_MODEL_FAST: "gpt-4.1-mini"  # Fast model for quick extraction
  EXTRACTOR_MODEL_CAPABLE: "gpt-4.1-mini"  # Capable model for complex extraction
  EXTRACTOR_MODEL_VISION: "gpt-4.1-mini"  # Vision model for image inputs
  EXTRACTOR_MAX_OUTPUT_TOKENS: "16384"  # Increase for longer summaries/keywords
```

All extraction adapters use OpenAI-compatible chat completions. For direct provider
swaps, set `EXTRACTOR_PROVIDER=openai` and point `OPENAI_BASE_URL` to the target
compatible endpoint.

## Tear Down

```bash
# Stop services (keep data)
docker compose down

# Stop services and delete data volumes
docker compose down -v
```

## Developing the API

For hot-reload during API development:

```bash
cd api
npm install
DATABASE_URL=postgresql://raged:password@localhost:5432/raged OLLAMA_URL=http://localhost:11434 npm run dev
```

This runs the API directly on your machine while Postgres runs in Docker.

## Developing the CLI

```bash
cd cli
npm install
npm run dev -- index --repo <url> --api http://localhost:8080

# Test URL ingestion
npm run dev -- ingest --url https://example.com/article --api http://localhost:8080
```

## URL Ingestion Examples

The API supports server-side URL fetching for web pages, PDFs, and other content types:

### Via HTTP API

**Ingest a web article:**
```bash
curl -s -X POST http://localhost:8080/ingest \
  -H "Content-Type: application/json" \
  -d '{
    "items": [{
      "url": "https://example.com/article"
    }]
  }'
```

**Ingest a PDF from URL:**
```bash
curl -s -X POST http://localhost:8080/ingest \
  -H "Content-Type: application/json" \
  -d '{
    "items": [{
      "url": "https://example.com/whitepaper.pdf",
      "source": "Example Whitepaper"
    }]
  }'
```

**Mixed batch (URLs + text):**
```bash
curl -s -X POST http://localhost:8080/ingest \
  -H "Content-Type: application/json" \
  -d '{
    "items": [
      {"url": "https://example.com/article"},
      {"text": "Direct text content", "source": "notes/snippet.txt"}
    ]
  }'
```

### Via CLI

```bash
# Ingest a web page
node dist/index.js ingest --url https://example.com/article --api http://localhost:8080

# Ingest a PDF
node dist/index.js ingest --url https://example.com/whitepaper.pdf --api http://localhost:8080
```

**Supported Content Types:**
- HTML (Readability article extraction)
- PDF (pdf-parse text extraction)
- Plain text, Markdown (passthrough)
- JSON (pretty-printed)

**SSRF Protection:**
URL ingestion includes automatic security protections:
- Blocks private IP ranges (10.x.x.x, 192.168.x.x, 127.x.x.x, etc.)
- DNS rebinding defense: resolves hostname before request and rejects private IPs
- Fixed 30-second request timeout
- Rejects non-HTTP/HTTPS schemes
