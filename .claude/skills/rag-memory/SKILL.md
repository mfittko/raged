# rag-memory

Use this skill to retrieve grounded context from the local/remote “memory” store via the CLI.

Env:
- `RAG_API_URL` (default `http://localhost:8080`)
- `RAG_API_TOKEN` (optional)

Query:
```bash
rag-index query --api "${RAG_API_URL:-http://localhost:8080}" --q "<question>" --topK 5 --token "${RAG_API_TOKEN:-}"
```
