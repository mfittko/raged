# Local development

## Run everything locally (encapsulated)
```bash
docker compose up -d
curl -s http://localhost:8080/healthz
```

## Optional auth locally
Set `RAG_API_TOKEN` in the `api` service environment and pass `--token` (or env `RAG_API_TOKEN`) in CLI calls.
