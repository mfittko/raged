# CLI (raged-index)

Command-line tool for indexing Git repositories, ingesting arbitrary files, and querying the RAG API.

## Build

```bash
cd cli
npm install
npm run build
```

## Commands

### index

Clone a Git repository, scan for text files, and ingest them into the RAG API.

```bash
node dist/index.js index --repo <git-url> [options]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--repo` | _(required)_ | Git URL to clone |
| `--api` | `http://localhost:8080` | RAG API URL |
| `--collection` | `docs` | Qdrant collection name |
| `--branch` | _(default branch)_ | Git branch to clone |
| `--repoId` | _(repo URL)_ | Stable identifier for this repo |
| `--token` | _(env `RAGED_API_TOKEN`)_ | Bearer token for auth |
| `--include` | _(all)_ | Only index files matching this path prefix |
| `--exclude` | _(none)_ | Skip files matching this path prefix |
| `--maxFiles` | `4000` | Maximum files to process |
| `--maxBytes` | `500000` | Maximum file size in bytes |
| `--keep` | `false` | Keep the cloned temp directory |
| `--enrich` | `true` | Enable async enrichment |
| `--no-enrich` | - | Disable async enrichment |
| `--doc-type` | _(auto-detect)_ | Override document type detection |

### query

Search the RAG API for relevant chunks.

```bash
node dist/index.js query --q "<search text>" [options]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--q` / `--query` | _(required)_ | Search query text |
| `--api` | `http://localhost:8080` | RAG API URL |
| `--collection` | `docs` | Qdrant collection name |
| `--topK` | `8` | Number of results to return |
| `--repoId` | _(none)_ | Filter by repository ID |
| `--pathPrefix` | _(none)_ | Filter by file path prefix |
| `--lang` | _(none)_ | Filter by language |
| `--token` | _(env `RAGED_API_TOKEN`)_ | Bearer token for auth |

### ingest

Ingest arbitrary files (PDFs, images, text, Slack exports) into the RAG API.

```bash
node dist/index.js ingest --file <path> [options]
node dist/index.js ingest --dir <path> [options]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--file` | - | Single file to ingest (mutually exclusive with --dir) |
| `--dir` | - | Directory to ingest (mutually exclusive with --file) |
| `--api` | `http://localhost:8080` | RAG API URL |
| `--collection` | `docs` | Qdrant collection name |
| `--token` | _(env `RAGED_API_TOKEN`)_ | Bearer token for auth |
| `--maxFiles` | `4000` | Maximum files to process from directory |
| `--enrich` | `true` | Enable async enrichment |
| `--no-enrich` | - | Disable async enrichment |
| `--doc-type` | _(auto-detect)_ | Override document type (`code`, `text`, `pdf`, `image`, `slack`) |

**Supported file types:**
- **Text/Code**: `.md`, `.txt`, `.ts`, `.js`, `.py`, `.go`, etc. — read as UTF-8
- **PDFs**: `.pdf` — extracted text via pdf-parse with metadata (title, author, pageCount)
- **Images**: `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp` — base64-encoded with EXIF metadata
- **Slack exports**: JSON files in Slack export format

### enrich

Trigger and monitor async enrichment tasks.

```bash
node dist/index.js enrich [options]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--api` | `http://localhost:8080` | RAG API URL |
| `--collection` | `docs` | Qdrant collection name |
| `--token` | _(env `RAGED_API_TOKEN`)_ | Bearer token for auth |
| `--force` | `false` | Re-enqueue all items (including already-enriched) |
| `--stats-only` | `false` | Show enrichment stats without enqueueing |

**Behavior:**
- Always shows enrichment statistics first
- By default, enqueues pending items after showing stats
- Use `--stats-only` to view stats without enqueueing
- Use `--force` to re-enqueue all items (including already-enriched)

**Examples:**

```bash
# Show enrichment stats only (no enqueueing)
node dist/index.js enrich --stats-only

# Show stats and enqueue pending items (default)
node dist/index.js enrich

# Show stats and force re-enrichment of all items
node dist/index.js enrich --force
```

### graph

Query the knowledge graph for entity information.

```bash
node dist/index.js graph --entity <name> [options]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--entity` | _(required)_ | Entity name to look up |
| `--api` | `http://localhost:8080` | RAG API URL |
| `--token` | _(env `RAGED_API_TOKEN`)_ | Bearer token for auth |

**Example:**

```bash
node dist/index.js graph --entity "AuthService"
```

**Output:**
```
=== Entity: AuthService ===
Type: class
Description: Handles user authentication

=== Connections (2) ===
  → JWT (uses)
  ← UserService (relates_to)

=== Related Documents (3) ===
  - my-repo:src/auth.ts:0
  - my-repo:src/auth.ts:1
  - my-repo:docs/auth.md:0
```

## Index Lifecycle

```mermaid
flowchart LR
    A[git clone<br/>--depth 1] --> B[Scan files]
    B --> C{Text file?}
    C -->|No| D[Skip]
    C -->|Yes| E{Size OK?}
    E -->|No| D
    E -->|Yes| F{Prefix filter?}
    F -->|Excluded| D
    F -->|Included| G[Read file]
    G --> H[Add to batch]
    H --> I{Batch full?}
    I -->|Yes| J[POST /ingest]
    I -->|No| B
    J --> B

    style D fill:#ffcdd2
    style J fill:#c8e6c9
```

## Authentication

Two ways to provide the auth token:

1. **Flag:** `--token my-token`
2. **Environment variable:** `export RAGED_API_TOKEN=my-token`

The flag takes precedence over the environment variable.

## Examples

Index a public repo:
```bash
node dist/index.js index \
  --repo https://github.com/fastify/fastify.git \
  --api http://localhost:8080 \
  --collection fastify-docs \
  --include docs/
```

Query with filters:
```bash
node dist/index.js query \
  --api http://localhost:8080 \
  --q "request validation" \
  --topK 5 \
  --collection fastify-docs \
  --lang md
```
