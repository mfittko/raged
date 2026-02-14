# Architecture

## Components
- **Qdrant**: vector DB storing embeddings + metadata payload
- **Ollama**: local embedding runtime (`/api/embeddings`)
- **RAG API**: Fastify service exposing:
  - `POST /ingest`: chunk → embed → upsert
  - `POST /query`: embed query → search
- **CLI**: indexes repos and queries the API
- **Claude Skill**: instructs Claude to use the CLI rather than stuffing context

## Security (MVP)
The API can be protected with a simple bearer token:
- API checks `Authorization: Bearer <token>`
- Token provided via env `RAG_API_TOKEN`
- Helm renders a Secret and injects the env var into the API Deployment
