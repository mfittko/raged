---
name: raged
description: >
  CLI-first workflow for raged semantic search, ingestion, enrichment, and graph lookup.
  Use the `raged` command as the default interface for grounded context retrieval.
  Supports code/docs/media ingestion, async metadata extraction, and graph-aware retrieval.
version: 1.0.0
compatibility: Requires raged CLI and a running raged instance (Docker Compose or Kubernetes)
metadata:
  openclaw:
    emoji: "magnifying_glass"
    requires:
      bins:
        - raged
      env:
        - RAGED_URL
    primaryEnv: RAGED_URL
    config:
      apiToken:
        description: "Bearer token for raged API authentication (optional if auth is disabled)"
        secret: true
---

# raged — CLI-First Semantic Knowledge Base

Use `raged` as the primary interface for indexing, querying, enrichment control, and graph exploration.

raged ingests content, chunks text, embeds vectors in Postgres + pgvector, and supports async enrichment and graph-aware retrieval.

## Environment

| Variable | Purpose | Example |
|----------|---------|---------|
| `RAGED_URL` | Base URL of the raged API used by the CLI | `http://localhost:39180` |
| `RAGED_API_TOKEN` | Bearer token used by the CLI when auth is enabled | `my-secret-token` |

## Pre-flight (CLI-first)

If needed, start the stack:

```bash
docker compose up -d --build
```

Verify API is reachable:

```bash
curl -sf "$RAGED_URL/healthz"
```

## Query (Primary Workflow)

Start with collection discovery when scope is unknown:

```bash
raged collections
```

Use the default query pattern first, then add only the flags you need:

```bash
raged query "<your query>" --collection docs --topK 5
```

Common examples:

```bash
raged query "authentication middleware" --collection docs --topK 5
raged query "invoice INV89909018" --collection downloads-pdf --summary short --keywords --topK 8
raged query "route handler" --collection docs --repoId my-repo --pathPrefix src/api/ --lang ts
raged query "invoice INV89909018" --collections downloads-pdf,docs --topK 8
raged query "invoice INV89909018" --allCollections --topK 8
raged query "invoice INV89909018" --collections downloads-pdf,docs --topK 20 --unique
raged query "invoice INV89909018" --collection downloads-pdf --download
raged query "invoice INV89909018" --collection downloads-pdf --open
```

### Query flag guide

- `--collection <name>`: fastest and least noisy when source is known.
- `--collections a,b`: use when content likely spans a small known set.
- `--allCollections`: use only for discovery, then rerun with narrower scope.
- `--topK`: `5-10` for Q&A, `20-50` for audits/extraction, `100` for broad inventory pulls.
- `--summary short`: compact extraction (dates, amounts, entities).
- `--summary long`: richer extracted context when short summaries are insufficient.
- `--full --stdout`: fallback for full extracted document text in terminal when summaries are unhelpful.
- `--keywords`: readability aid only; does not improve ranking.
- `--repoId`, `--pathPrefix`, `--lang`: tighten code/repo lookups.
- `--unique`: deduplicates multi-collection hits by payload checksum.

Fallback pattern when summary output is weak:

```bash
raged query "<your query>" --collection downloads-pdf --topK 1 --summary long
raged query "<your query>" --collection downloads-pdf --topK 1 --full --stdout
```

Use this especially for invoices/receipts where key fields (IBAN, totals, reference IDs) may not appear in summary output.

### Scoring defaults

- Default is `--minScore auto`; keep it unset initially.
- Auto thresholds by query term count:
  - 1 term: `0.3`
  - 2 terms: `0.4`
  - 3-4 terms: `0.5`
  - 5+ terms: `0.6`
- Lower (`0.2-0.4`) only when recall is too low.
- Raise (`0.55+`) when results stay noisy after narrowing scope.
- Avoid `--minScore 0` outside diagnostics.

### Calibration pattern (when needed)

Probe first, then scale:

```bash
raged query "<your query>" --collection docs --topK 1
```

Take score `s`, then optionally rerun with `--minScore (s - 0.05)` and higher `--topK`.

Suggested sequence:

1. `raged collections`
2. Query narrow scope (`--collection` or `--collections`)
3. Keep `--minScore` unset (`auto`)
4. Add `--summary short` for extraction
5. Add `--keywords` only for scanability
6. Expand `--topK` last

### Canonical pattern: monetary totals in a period

Use this for questions like “How much did we pay vendor X in year Y?”

**Hard rule:** if matched context is manageable, do not use Python/scripts. Extract and sum directly from retrieved results.

Principles:

- Keep `--minScore` unset (`auto`) by default.
- Keep `--topK <= 100`.
- Prefer `--collection`/`--collections` over `--allCollections`.
- Use precise terms: payer/org, vendor, `invoice`, and period.

Recommended retrieval:

```bash
raged query "<payer> <vendor> invoice <year>" \
  --collections <billing-collection>,docs \
  --topK 100 \
  --summary short
```

Aggregation hygiene (outside retrieval):

- Primary strategy (mandatory): if the matched invoice set is manageable and clearly readable, do not use Python/scripts; perform the total manually from the retrieved output.
- Use Python/script parsing only as a fallback when manual arithmetic is impractical (large/ambiguous result sets) or when reproducibility is explicitly required.
- Require a double-check before finalizing any reported total (recompute once independently, then compare).
- De-duplicate by stable invoice identifier/source path before summing.
- Sum only entries in the requested period.
- Keep currency explicit in the final answer and avoid mixing currencies in one total.
- If confidence is low, report matched invoice count and note potential missing records.

## Ingest (CLI-first)

Index a Git repository:

```bash
raged index --repo https://github.com/org/repo.git --collection docs
```

Ingest local files/directories:

```bash
raged ingest --file path/to/document.pdf --collection docs
raged ingest --dir path/to/content --collection docs
```

Directory ingest metadata behavior:

- `metadata.rootDir`: normalized absolute root directory passed via `--dir`.
- `metadata.relativePath`: path of each ingested file relative to `rootDir`.
- `metadata.path`: same relative value as `relativePath` for path-compatible retrieval/filtering.

`--doc-type` behavior with `--dir`:

- Candidate files are filtered first by detected type.
- Matching files are then ingested with the provided doc type forced.

Example:

```bash
raged ingest --dir ~/Downloads/invoices --doc-type pdf --collection downloads-pdf
```

This ingests only detected PDFs from the directory tree and preserves local-reference metadata (`rootDir` + relative path) for later source resolution.

Skip noisy folders/files during directory ingest:

```bash
raged ingest --dir ~/Documents --doc-type pdf --ignore "tmp/**,**/*.bak" --collection downloads-pdf
```

Or keep ignore rules in a file:

```bash
raged ingest --dir ~/Documents --doc-type pdf --ignore-file ~/.config/raged/ingest.ignore --collection downloads-pdf
```

Tune request size for large ingests (helpful when API body limits are strict):

```bash
raged ingest --dir ~/Documents --doc-type pdf --batchSize 5 --collection downloads-pdf
```

Useful indexing controls:

```bash
raged index \
  --repo https://github.com/org/repo.git \
  --collection docs \
  --include src/ \
  --exclude dist/ \
  --maxFiles 4000 \
  --maxBytes 500000
```

Indexing guidance:

- Use `index` for Git repositories and `ingest` for local files/directories.
- Start with narrow collection targets (`docs`, `downloads-pdf`, etc.).
- Use `--ignore`/`--ignore-file` early to avoid noisy content.
- Reduce `--batchSize` when API body limits are strict.

## Enrichment (CLI-first)

Check enrichment queue stats:

```bash
raged enrich --stats
```

Stats output is scoped by the selected `--collection` and optional `--filter`.

Enqueue pending work:

```bash
raged enrich
```

Force re-enrichment (optionally filtered):

```bash
raged enrich --force
raged enrich --force --filter invoice
```

Clear queued tasks (optionally filtered):

```bash
raged enrich --clear
raged enrich --clear --filter invoice
```

## Graph (CLI-first)

Query an entity and inspect connected documents:

```bash
raged graph --entity "AuthService"
```

## Optional API fallback

Use direct HTTP only when CLI does not cover a needed workflow:

```bash
curl -s -X POST "$RAGED_URL/query" \
  -H "Content-Type: application/json" \
  -d '{"query": "authentication middleware", "topK": 5}'
```

## Troubleshooting

| Symptom | Action |
|---------|--------|
| Connection refused | `docker compose up -d --build` |
| Unauthorized | Set `RAGED_API_TOKEN` or pass `--token` |
| No results | Lower threshold (`--minScore 0.2`) or increase `--topK` |
| Enrichment not progressing | Ensure enrichment worker is running (`docker compose ps`) |
