# Contributing

How to develop, test, and submit changes to rag-stack.

## Development Setup

### Prerequisites

- Node.js 20+
- Docker and Docker Compose
- Git

### First-Time Setup

```bash
# Clone the repo
git clone https://github.com/<org>/rag-stack.git
cd rag-stack

# Start infrastructure
docker compose up -d

# Pull embedding model
curl http://localhost:11434/api/pull -d '{"name":"nomic-embed-text"}'

# Install and build both packages
cd api && npm install && npm run build && cd ..
cd cli && npm install && npm run build && cd ..
```

### Development Workflow

```mermaid
flowchart LR
    B[Create branch] --> C[Write failing test]
    C --> I[Implement]
    I --> T[Run tests]
    T --> P{Pass?}
    P -->|No| I
    P -->|Yes| CO[Commit]
    CO --> PR[Open PR]

    style C fill:#fff3e0
    style CO fill:#c8e6c9
```

## Branch Naming

```
feat/<short-description>    # New features
fix/<short-description>     # Bug fixes
docs/<short-description>    # Documentation
refactor/<short-description> # Code improvements
test/<short-description>    # Test additions
```

## Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add query caching for repeated searches
fix: handle empty file during indexing
docs: add Mermaid diagram to architecture doc
refactor: extract embedding client interface
test: add unit tests for chunking module
chore: update dependencies
```

Keep the first line under 72 characters. Add a body for complex changes.

## Pull Requests

1. Branch from `main`
2. Keep PRs focused — one logical change per PR
3. Ensure CI passes (build + lint)
4. Write a clear description: what changed and why
5. Link related issues if applicable

## Project Structure

```
rag-stack/
├── api/          → Fastify RAG API (see api/AGENTS.md)
├── cli/          → CLI indexer tool (see cli/AGENTS.md)
├── chart/        → Helm chart (see chart/AGENTS.md)
├── docs/         → Documentation (see docs/AGENTS.md)
├── .claude/      → Claude Code skill definitions
├── .github/      → CI/CD workflows
└── AGENTS.md     → Project-wide coding principles
```

## Code Style

- TypeScript with strict mode
- ES modules (`import`/`export`, not `require`)
- No `any` in new code
- Named exports only (no default exports)

See [AGENTS.md](../AGENTS.md) for the full set of conventions.

## Adding a New API Endpoint

1. Add the route in `api/src/server.ts`
2. Add JSON Schema validation for input
3. Delegate logic to a service module (not inline in the handler)
4. Update `docs/09-api-reference.md`

## Adding a New CLI Command

1. Add the command handler in `cli/src/index.ts`
2. Update the `usage()` function with all flags
3. Update `docs/03-cli.md`
