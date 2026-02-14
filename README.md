# rag-stack (MVP: CLI + Skills + self-hosted RAG API)

This repo ships a practical “memory” layer for coding agents:
- **RAG API** (Fastify) backed by **Qdrant** + local embeddings via **Ollama**
- **CLI** (`rag-index`) for indexing and querying (keeps heavy work outside the model loop)
- **Claude Code Skill** that instructs Claude to use the CLI (token-efficient)
- **Docker Compose** for local encapsulated deployment
- **Helm** for Kubernetes deployment (Ingress + optional token auth)
- **In-cluster indexing Job** (v0.5): run the same CLI close to the cluster/VPC, so laptops don’t upload repo contents

## Quickstart (local)

```bash
docker compose up -d
curl -s http://localhost:8080/healthz
```

(Optional) pull embedding model:
```bash
curl http://localhost:11434/api/pull -d '{"name":"nomic-embed-text"}'
```

## CLI

Build:
```bash
cd cli && npm install && npm run build
```

Index:
```bash
node dist/index.js index --repo https://github.com/<org>/<repo>.git --api http://localhost:8080
```

Query:
```bash
node dist/index.js query --api http://localhost:8080 --q "authentication flow" --topK 5
```

## Remote (Helm + Ingress + token)

See `docs/05-helm-remote.md`.

## In-cluster indexing (recommended for remote deployments)

See `docs/07-indexing-in-cluster.md`.
