# CLI (rag-index)

Build:
```bash
cd cli
npm install
npm run build
```

## Index
```bash
node dist/index.js index --repo <git-url> --api <url> --collection docs --token <token?>
```

## Query
```bash
node dist/index.js query --api <url> --q "vector search" --topK 8 --token <token?>
```

## Auth
- `--token <token>` or env `RAG_API_TOKEN`
