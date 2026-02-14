# AGENTS.md — rag-stack

## Project Identity

rag-stack is a **multi-agent memory hub**: a shared retrieval-augmented generation (RAG) layer that any AI coding agent can use to store and retrieve grounded context from indexed repositories. The API is stateless; all persistent state lives in Qdrant.

## Core Principles

### SOLID

- **Single Responsibility (SRP):** Each module does exactly one thing. `chunking.ts` chunks text. `ollama.ts` embeds text. `qdrant.ts` manages vector storage. Do not mix concerns.
- **Open/Closed:** Add new embedding providers or vector backends via new modules, not by modifying existing ones. Design for adapter patterns when the third use case appears.
- **Liskov Substitution:** If you introduce an interface, every implementation must be a drop-in replacement. No special-casing.
- **Interface Segregation:** Keep interfaces small and focused. A consumer of embeddings should not depend on chunking types.
- **Dependency Inversion:** Core logic depends on abstractions. Route handlers call service functions, not infrastructure clients directly.

### KISS

Keep it simple. If a solution requires more than one level of indirection, justify it. Prefer flat, readable code over clever abstractions. A 10-line function that's easy to follow beats a 3-line function that requires reading 4 other files.

### DRY

Extract shared logic only when it appears three or more times. Two similar blocks of code are fine — premature abstraction is worse than mild duplication. Shared TypeScript types live in a common location when used across packages.

### YAGNI

Do not build features until they are needed. Design so that future features are possible, but do not implement them. No speculative interfaces, no unused configuration options, no "just in case" parameters.

## TypeScript Conventions

- **Strict mode** is mandatory (`strict: true` in tsconfig.json)
- **ES modules** only (`"type": "module"` in package.json)
- **No `any`** in new code. Use `unknown` + type narrowing, or define proper types. Existing `any` usage should be replaced when touching that code.
- **Prefer `interface` over `type`** for public API shapes (interfaces are extensible, types are not)
- **No classes** unless there's a clear lifecycle or state management need. Prefer plain functions and objects.
- **Named exports only.** No default exports — they make refactoring harder.

## Git Conventions

- **Conventional commits:** `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`
- **Small, focused commits.** One logical change per commit. If you can't describe it in one sentence, split it.
- **No force-push to main.** Ever.
- **Branch naming:** `feat/<short-description>`, `fix/<short-description>`, `docs/<short-description>`

## Testing Philosophy

- **TDD when writing logic:** Write the failing test first, then implement.
- **Unit tests** for pure logic (chunking, filtering, text processing)
- **Integration tests** for API routes (spin up Fastify, test request/response)
- **No tests for trivial code:** Simple getters, re-exports, and type definitions don't need tests.
- **Test file location:** Co-located next to source as `<module>.test.ts`
- **Test runner:** Vitest (when added)

## Performance Requirements

All code changes **must** be reviewed for performance impact. Specifically:

- **No O(n²) or worse patterns.** Nested loops over collections, repeated `Array.find`/`Array.filter` inside loops, or any pattern where work scales quadratically with input size must be refactored. Use `Map`, `Set`, or index lookups to achieve O(n) or O(n log n).
- **No N+1 queries.** Never issue one query per item in a collection. Batch reads and writes. If you're calling Qdrant, Neo4j, or any external service inside a loop, refactor to a single batch operation.
- **Bound memory consumption.** Process large datasets with streaming or chunked iteration — never load unbounded collections into memory. Use pagination for API responses and database reads. Set explicit limits on array sizes, queue depths, and buffer lengths.
- **Avoid unnecessary allocations in hot paths.** Don't create intermediate arrays, objects, or closures inside tight loops when the result can be computed in-place or with a single pass.
- **Prefer `for...of` over chained array methods** when processing large collections where intermediate arrays would be wasteful.
- **Index-aware database access.** Every query pattern must have a supporting index. Document required indexes alongside the query code.
- **Measure before optimizing.** Don't optimize code that isn't a bottleneck. But do flag code that is obviously inefficient regardless of current scale — the data will grow.

## Architecture Guardrails

- **Stateless API:** The Fastify API holds no state. All persistence is in Qdrant. This makes horizontal scaling trivial.
- **No ORM.** Qdrant has a first-party JS client. Use it directly.
- **Minimal dependencies.** Every new dependency must justify its existence. Prefer Node.js built-ins.
- **Environment-driven configuration.** All config via environment variables. No config files, no `.env` loading in production code.

## Security Baseline

- **Never log tokens or secrets.** Not even partially. Not even in debug mode.
- **Validate at system boundaries:** Validate all input at API route level. Internal function calls can trust their callers.
- **Timing-safe comparisons** for any secret comparison (tokens, API keys).
- **No secrets in code or defaults.** Secrets must be provided via environment variables or Kubernetes Secrets.

## File Organization

```
cli/          → CLI indexer tool (thin orchestrator)
api/          → Fastify RAG API server
chart/        → Helm chart for Kubernetes deployment
docs/         → Project documentation
.claude/      → Claude Code skill definitions
.github/      → CI/CD workflows
```
