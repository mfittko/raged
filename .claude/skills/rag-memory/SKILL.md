# rag-memory

Use this skill to retrieve grounded context from the local/remote “memory” store via the CLI.

Env:
- `RAGED_URL` (default `http://localhost:8080`)
- `RAGED_API_TOKEN` (optional)

Query:
```bash
raged-index query --api "${RAGED_URL:-http://localhost:8080}" --q "<question>" --topK 5 --token "${RAGED_API_TOKEN:-}"
```
