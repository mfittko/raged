# raged

A vector-first knowledge base for AI agents — ingest any text (code, docs, articles, transcripts, notes), embed it locally, and retrieve relevant context via semantic search and knowledge graph traversal.

```mermaid
graph LR
    Agent[AI Agent] -->|"raged query"| CLI[CLI]
    CLI -->|HTTP| API[RAGED API]
    API -->|embed| Ollama
    API -->|search| Qdrant
    API -->|graph expand| Neo4j
    API -->|enqueue| Redis
    Worker -->|process| Redis
    Worker -->|extract| Neo4j
    Worker -->|update| Qdrant
    Worker -->|"extract (tier-3)"| Ollama

    style API fill:#e1f5fe
    style Qdrant fill:#f3e5f5
    style Ollama fill:#e8f5e9
    style Neo4j fill:#fce4ec
    style Redis fill:#fff9c4
    style Worker fill:#e0f2f1
```

## What It Does

1. **Ingest** text or URLs — send content directly to the API via HTTP, fetch web pages/PDFs server-side, or use the CLI to bulk-index Git repositories
2. **Embed** each chunk using a local model (Ollama + nomic-embed-text)
3. **Store** embeddings in Qdrant (vector DB)
4. **Query** by natural language — semantic similarity search for context-rich results

AI agents (Claude Code, OpenClaw, or any HTTP/CLI-capable agent) use this to retrieve grounded context without stuffing entire knowledge bases into their context window. Vector search finds *what's relevant*; knowledge graph traversal finds *what's connected*.

## Quickstart

```bash
# Start the base stack (Qdrant, Ollama, API)
docker compose up -d

# Or start with enrichment and knowledge graph
docker compose --profile enrichment up -d

# Pull the embedding model (first time only)
curl http://localhost:11434/api/pull -d '{"name":"nomic-embed-text"}'

# Verify
curl -s http://localhost:8080/healthz
# → {"ok":true}
```

## Ingest Content

Via the HTTP API (text or URLs):

```bash
# Ingest text directly
curl -s -X POST http://localhost:8080/ingest \
  -H "Content-Type: application/json" \
  -d '{
    "items": [{
      "id": "my-doc",
      "text": "Your text content here...",
      "source": "notes/meeting.md"
    }]
  }'

# Ingest from URL (server-side fetch)
curl -s -X POST http://localhost:8080/ingest \
  -H "Content-Type: application/json" \
  -d '{
    "items": [{
      "url": "https://example.com/article"
    }]
  }'
```

Via the CLI (bulk Git repository indexing):

```bash
cd cli && npm install && npm run build

node dist/index.js index \
  --repo https://github.com/<org>/<repo>.git \
  --api http://localhost:8080
```

## Query

```bash
curl -s -X POST http://localhost:8080/query \
  -H "Content-Type: application/json" \
  -d '{"query": "authentication flow", "topK": 5}'

# Or via CLI
node dist/index.js query \
  --api http://localhost:8080 \
  --q "authentication flow" \
  --topK 5
```

## Components

| Component | Role | Tech |
|-----------|------|------|
| **RAGED API** | Chunk, embed, store, search, orchestrate enrichment | Fastify, Node.js |
| **Qdrant** | Vector storage and similarity search | Qdrant v1.10 |
| **Ollama** | Local embedding and LLM runtime | nomic-embed-text (768d), llama3, llava |
| **Redis** | Enrichment task queue *(optional)* | Redis 7 |
| **Neo4j** | Knowledge graph storage *(optional)* | Neo4j 5 Community |
| **Enrichment Worker** | Async metadata extraction *(optional)* | Python, spaCy, asyncio |
| **CLI** | Bulk-index Git repos and query from terminal | Node.js, TypeScript |
| **Helm Chart** | Kubernetes deployment | Helm 3 |

## Documentation

Documentation Site (GitHub Pages): https://mfittko.github.io/raged/

| Doc | Topic |
|-----|-------|
| [Vision & Roadmap](docs/00-vision.md) | Where raged is headed |
| [Architecture](docs/01-architecture.md) | Components, data flow, security |
| [Local Development](docs/02-local-dev.md) | Docker Compose setup |
| [CLI Reference](docs/03-cli.md) | Commands, flags, examples |
| [Agent Integrations](docs/04-claude-skills.md) | Using raged with Claude Code, OpenClaw, etc. |
| [Helm Deployment](docs/05-helm-remote.md) | Kubernetes + Ingress + auth |
| [Troubleshooting](docs/06-troubleshooting.md) | Common issues and fixes |
| [In-Cluster Indexing](docs/07-indexing-in-cluster.md) | Indexing from inside Kubernetes |
| [Contributing](docs/08-contributing.md) | Development setup and PR process |
| [API Reference](docs/09-api-reference.md) | Endpoints, request/response formats |

## License

See [LICENSE](LICENSE).
