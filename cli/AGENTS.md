# AGENTS.md — cli/

> Inherits all principles from the root [AGENTS.md](../AGENTS.md). This file adds CLI-specific rules.

## Module Structure

```
src/
  index.ts    → CLI entry point, command parsing, orchestration
```

## Rules

### Thin Orchestrator

The CLI is a coordinator, not a business logic engine. It: parses arguments, calls the RAG API over HTTP, and formats output. All heavy logic (chunking, embedding, storage) lives in the API.

### Typed HTTP Client

All HTTP calls to the RAG API should go through typed helper functions (see `ingest()` and `query()` in `index.ts`). Never construct `fetch()` calls inline in command handlers. Always type request and response shapes.

### Every Command Has Help

Every CLI command must be represented in the `usage()` function with its full flag list, defaults, and a brief description. If you add a flag, update `usage()`.

### Actionable Error Messages

Error messages must tell the user what to do, not just what failed.

- Bad: `Error: 401`
- Good: `Error: 401 Unauthorized — pass --token or set RAGED_API_TOKEN`

### File Scanning

- Respect ignore patterns: `.git`, `node_modules`, `dist`, `build`, `target`, etc.
- Skip binary files (images, archives, fonts, media)
- Respect `--include` and `--exclude` prefix filters
- Enforce `--maxFiles` and `--maxBytes` limits to prevent accidental huge ingestions

### Batch Ingestion

Ingest files in batches (currently 50 items) to avoid overwhelming the API with a single massive request. Do not send all files in one payload.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `RAGED_API_TOKEN` | _(empty)_ | Bearer token (alternative to `--token` flag) |
