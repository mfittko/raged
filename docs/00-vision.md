# Vision

rag-stack is a vector-first knowledge base for AI agents with relationship-aware graph retrieval planned on the roadmap.

## Why

AI agents work best with relevant context, but stuffing entire knowledge bases into a model's context window is wasteful and expensive. rag-stack keeps the heavy retrieval work outside the model loop: ingest once, query many times, return only what's relevant.

Vector search alone finds *semantically similar* content. But real knowledge has structure — docs reference code, emails discuss designs, repos depend on libraries. A planned graph layer will capture these relationships, enabling retrieval that follows connections, not just similarity. The roadmap combination is more powerful than either alone:

| Query type | Vector DB | + Graph DB |
|-----------|----------|------------|
| "Find code about auth" | Semantic match | Same |
| "What docs reference this function?" | Can't | Follow edges |
| "Show the email thread behind this design" | Can't | Traverse relationships |
| "What depends on this library?" | Can't | Dependency graph |
| "Find auth code AND everything connected to it" | Partial | Hybrid: similarity + graph neighbors |

## Architecture Overview

```mermaid
graph TD
    A1[AI Agent 1<br/>Claude Code] -->|query| CLI[rag-index CLI]
    A2[AI Agent 2<br/>OpenClaw] -->|query| CLI
    A3[AI Agent N] -->|HTTP| API
    CLI -->|HTTP| API[RAG API<br/>Fastify]
    API -->|embed| OL[Ollama<br/>nomic-embed-text]
    API -->|similarity search| QD[Qdrant<br/>Vector DB]
    API -->|planned traversal| GD[Graph DB (planned)]
    API -->|planned hybrid retrieval| QD
    API -->|planned hybrid retrieval| GD
    CLI -->|ingest| API

    style API fill:#e1f5fe
    style QD fill:#f3e5f5
    style OL fill:#e8f5e9
    style GD fill:#fff3e0
```

## Roadmap

### v0.5 — MVP (current)

What exists today:

- HTTP API: `/ingest` and `/query` endpoints — content-agnostic, accepts any text
- CLI indexer: bulk-index Git repos (clone, chunk, ingest via API)
- Bearer token authentication
- Docker Compose for local development
- Helm chart for Kubernetes deployment
- In-cluster indexing Job
- Agent integrations: Claude Code skill, OpenClaw AgentSkill

### v1.0 — Production Ready + Relationship Tracking

Hardening the vector layer and adding explicit relationship tracking:

**Production hardening:**
- **Testing:** Unit tests for core logic, integration tests for API routes
- **Input validation:** JSON Schema on all API routes
- **Multiple embedding providers:** Adapter pattern — swap Ollama for OpenAI, Cohere, or local alternatives
- **Pluggable vector backends:** Qdrant today, Pinecone/Weaviate/pgvector via adapters
- **Rate limiting and request throttling**
- **Structured logging and health checks** (beyond `/healthz`)
- **API versioning** (`/v1/ingest`, `/v1/query`)

**Graph layer — relationship tracking:**
- **Explicit edges:** API to declare relationships between content (e.g., "this doc references that code", "this email discusses that design")
- **`POST /link`** endpoint to create typed, directed edges between ingested items
- **Relationship-aware queries:** "find X and everything connected to it" — vector search + graph traversal combined
- **Link types:** `references`, `depends-on`, `discusses`, `supersedes`, `authored-by` (extensible)
- **Graph storage:** Lightweight graph DB alongside Qdrant (e.g., Neo4j, or start with adjacency lists in Qdrant payloads)

### v2.0 — Knowledge Graph + Multi-Agent Hub

The full vision — automatic entity extraction and hybrid retrieval:

**Knowledge graph:**
- **Entity extraction:** Automatically identify entities (functions, classes, people, projects, concepts) from ingested text using LLM or NER
- **Relation extraction:** Discover implicit relationships between entities across content
- **GraphRAG:** Boost vector search results by graph proximity — hits that are graph-neighbors of already-relevant results rank higher
- **Graph queries:** Traverse the knowledge graph directly (e.g., "what depends on library X across all collections?")

**Multi-agent hub:**
- **Multi-tenancy:** Isolated collections per team/project with scoped tokens
- **Agent authentication:** Per-agent API keys with fine-grained permissions
- **Cross-collection search:** Federated queries across multiple collections
- **Real-time sync:** Webhook-triggered re-indexing when content sources change
- **Agent collaboration:** Shared memory spaces where multiple agents contribute and query
- **Observability:** Distributed tracing, query analytics, embedding cache hit rates
- **SDK/client libraries:** TypeScript, Python, Go clients (beyond CLI)

## Principles

- **Stateless API, stateful storage.** The API process holds no state. Scale it horizontally.
- **Local-first.** Docker Compose must always work. Cloud deployment is optional.
- **Agent-agnostic.** Not tied to any single agent. Claude Code, OpenClaw, or any agent that can call HTTP or shell out to a CLI can use rag-stack.
- **Content-agnostic.** Not just for code. Any text content — docs, articles, emails, transcripts — is a first-class citizen.
- **Minimal dependencies.** Every dependency must justify its existence.
- **Security by default.** Auth is optional locally, mandatory in production.
