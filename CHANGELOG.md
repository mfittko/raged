# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Common Changelog](https://common-changelog.org/).

---



## February 25, 2026

### Added

- **Three-tier query router** ([#120](https://github.com/mfittko/RAGed/pull/120)): Introduced a routing pipeline for POST /query that prioritizes explicit strategies, deterministic rules, and an LLM fallback with a circuit breaker, while including routing metadata on every response for downstream consumers.
- **Metadata Filter DSL** ([#119](https://github.com/mfittko/RAGed/pull/119)): Adds a filter DSL to the metadata strategy engine so queries can express metadata constraints more precisely before the retrieval step.
- **Metadata-Only Query Path** ([#119](https://github.com/mfittko/RAGed/pull/119)): Introduces a dedicated metadata-only query execution path that skips full retrieval when only metadata is required, improving efficiency.
- **Temporal CLI Flags** ([#119](https://github.com/mfittko/RAGed/pull/119)): Adds temporal start/end options to the CLI query command to let users scope queries to a specific time window.
- **Graph traversal strategy** ([#118](https://github.com/mfittko/RAGed/pull/118)): Introduces a GraphBackend abstraction, SqlGraphBackend implementation, and new strategy orchestration so POST /query executes RFC #114–aligned graph traversals with bounded depth, cycle detection, entity caps, deterministic deduplication, timeout handling, and consistent relationship filtering.

### Changed

- **Relaxed query validation** ([#120](https://github.com/mfittko/RAGed/pull/120)): Updated the schema/prevalidation so requests can rely on filters when the query is empty, added coverage for invalid strategy errors returning 400, and refined request tests to exercise the enhanced validation.
- **Graph API validation** ([#118](https://github.com/mfittko/RAGed/pull/118)): Adds graph request schemas, graphExpand compatibility, mutual exclusion handling, and entity resolution routing via the backend plus a case-insensitive entity name index migration to ensure the new strategy is surfaced safely.

## February 24, 2026

### Added

- **Auto Provider Selection** ([#104](https://github.com/mfittko/RAGed/pull/104)): Adds `resolve_extractor_provider()` plus new env vars and model defaults to auto-detect OpenAI/Anthropic/Ollama based on available credentials while still allowing explicit overrides, preventing invalid configs from silently mis-selecting providers.

### Changed

- **Robust OpenAI/Ollama Adapters** ([#104](https://github.com/mfittko/RAGed/pull/104)): Updates the OpenAI adapter to accept base URL/API key overrides, fail fast on missing keys for public endpoints, and improve JSON extraction/fallback logic while keeping civic vision token limits, then rewrites the Ollama adapter as a thin OpenAI-compatible wrapper that normalizes its `/v1` endpoint.
- **Expanded Schema Summaries & Invoices** ([#104](https://github.com/mfittko/RAGed/pull/104)): Enriches all eight content schemas with short/medium/long summaries, keywords, and consistent default strings while adding structured invoice metadata/line items to PDFs so prompts explicitly request these fields for more reliable downstream data.
- **Tier3 Metadata Normalization** ([#104](https://github.com/mfittko/RAGed/pull/104)): Introduces `_normalize_tier3_metadata()` to post-process LLM output before storage, improving consistency of the metadata that feeds the rest of the pipeline.



## February 19, 2026

### Added

- **Adaptive Query Responses** ([#101](https://github.com/mfittko/RAGed/pull/101)): Added adaptive `minScore` handling, document summary/checksum fields in query responses, and accompanying schema/server tests so similarity thresholds and metadata better match user intent.
- **Download and Collection APIs** ([#101](https://github.com/mfittko/RAGed/pull/101)): Introduced download-first/fulltext-first query endpoints, collection listing, filename sanitization, and improved blob-store error handling to support safe document downloads and metadata retrieval.
- **Full-text enrichment filters** ([#99](https://github.com/mfittko/RAGed/pull/99)): Added dual-mode filtering across enrichment stats, enqueue, and queue clearing so operators can target text, sources, types, and summaries with PostgreSQL websearch queries and ILIKE fallbacks.
- **Enrichment queue clearing** ([#99](https://github.com/mfittko/RAGed/pull/99)): Introduced clearEnrichmentQueue to wipe pending, processing, and dead tasks (with optional filters) for quicker queue resets during operational work.
- **Structured error metadata** ([#99](https://github.com/mfittko/RAGed/pull/99)): failure handling now records rich error metadata per chunk and surface errors via getEnrichmentStatus, improving diagnostics and retry visibility.

### Changed

- **Document-level summaries** ([#99](https://github.com/mfittko/RAGed/pull/99)): Moved summary_short/medium/long from chunk metadata to the documents table with fallback helpers, ensuring summaries persist at the document level while keeping chunk metadata clean.

## February 17, 2026

### Added

- **Embedding Provider Abstraction** ([#96](https://github.com/mfittko/RAGed/pull/96)): New orchestrator routes embedding requests through Ollama or OpenAI adapters with configurable concurrency, unified validation, and environment-based provider selection while keeping existing Ollama imports working unchanged.
- **Payload Checksum Migrations** ([#81](https://github.com/mfittko/RAGed/pull/81)): Introduced new SQL migrations to store payload checksums and optional raw bytes so ingest metadata persists the original source content required for idempotency and raw-data verification.

### Changed

- **Embedding Vector Migration** ([#96](https://github.com/mfittko/RAGed/pull/96)): Migration 004 drops and rebuilds chunk embeddings as 1536-dimensional vectors with a fresh HNSW index (requiring re-ingestion) and Migration 005 adds multi-level document summary columns with backfill, while config validation enforces the right env vars for the selected provider.
- **Exact Raw Ingest Handling** ([#81](https://github.com/mfittko/RAGed/pull/81)): Updated ingest contracts, pipeline, and blob-store integration to persist raw payload bytes or offload large payloads while computing checksums, reusing S3 clients, and ensuring idempotent skips only occur when content is unchanged.
- **10MB Body Limit** ([#81](https://github.com/mfittko/RAGed/pull/81)): Added and documented the 10MB ingest body limit across env configs, docs, and server settings so oversized requests fail fast while chunked uploads are still pending.

## February 16, 2026

### Added

- **GHCR image publishing** ([#79](https://github.com/mfittko/RAGed/pull/79)): CI workflow now builds and pushes multi-arch `ghcr.io/mfittko/{raged-api,raged,raged-worker}` images on main and `v*.*.*` tags, producing deterministic `main`, `sha-*`, semantic version, and release-only `latest` tags.
- **Service Healthchecks** ([#70](https://github.com/mfittko/raged/pull/70)): Docker Compose now performs healthchecks for qdrant and ollama and gates service startup on healthy status to ensure dependent services are ready before the API begins operations.
- **Postgres Database Layer** ([#63](https://github.com/mfittko/raged/pull/63)): Added the `db` module with a Postgres pool, query helper, migration runner, unit tests, and the initial schema migration so the API boots its tables on startup and enqueues enrichment work via Postgres.

### Changed

- **GHCR defaults & docs** ([#79](https://github.com/mfittko/RAGed/pull/79)): Helm values, deployment docs, and the contributing guide now reference the official GHCR repositories/tags and describe the new publish triggers and `latest` policy.
- **Drop legacy storage layers** ([#78](https://github.com/mfittko/RAGed/pull/78)): Removed Qdrant, Neo4j, and Redis compatibility scaffolding so the API/worker stack now depends solely on Postgres (with pgvector) and Ollama, and updated runtime config, tests, CLI messaging, and docs to reflect the Postgres-only architecture.
- **Verify worker API readiness** ([#76](https://github.com/mfittko/RAGed/pull/76)): Worker deployment now probes the API `/healthz` endpoint over HTTP, ensuring the worker only becomes ready once the API it depends on is healthy.
- **Plain filter objects** ([#75](https://github.com/mfittko/RAGed/pull/75)): Query commands now build simple key-value filters and send them directly so the Postgres backend can translate them to SQL, eliminating the previous Qdrant-specific payload and helper.
- **Updated CLI help text** ([#75](https://github.com/mfittko/RAGed/pull/75)): All CLI help messages now refer to generic “Collection” terminology instead of the Qdrant-specific phrasing to reflect the backend migration.
- **Worker HTTP storage migration** ([#74](https://github.com/mfittko/RAGed/pull/74)): Worker now polls and reports tasks through new internal API HTTP endpoints instead of direct Postgres access, including a dedicated async HTTP client, updated pipeline, and API-based config, cutting asyncpg/pgvector usage and resulting in a leaner worker codebase.
- **Startup Config Guard** ([#70](https://github.com/mfittko/raged/pull/70)): API startup now validates DATABASE_URL, OLLAMA_URL, and QDRANT_URL (with tests) before calling listen(), preventing confusing downstream failures when essential config is missing.
- **Token Hardening Warning** ([#70](https://github.com/mfittko/raged/pull/70)): The auth module now warns when RAGED_API_TOKEN is shorter than 16 characters, highlighting weak secrets during startup and covering the behavior with tests.
- **Config Docs & Defaults** ([#70](https://github.com/mfittko/raged/pull/70)): Updated `.env.example` with worker environment variables and refreshed worker default DB URL naming to `raged`, aligning documentation and runtime defaults with the current stack.
- **Project Renamed to raged** ([#67](https://github.com/mfittko/raged/pull/67)): Renamed the repo, packages, CLI binary, Helm chart, skill/plugin files, docs, and environment variables from the old rag-stack names to raged variants so tooling, manifests, and credentials match the new branding.
- **Postgres API Services** ([#65](https://github.com/mfittko/raged/pull/65)): Rewrote the ingest, query, and enrichment services along with shared helpers to run entirely on Postgres, preserving functionality while fixing SQL injection risks, batching upserts, enforcing validation, and tightening connection handling for pgvector-driven searches.
- **Internal Task Endpoints** ([#65](https://github.com/mfittko/raged/pull/65)): Added Postgres-backed internal endpoints for claiming tasks, writing results, handling failures, and recovering stale work, plus comprehensive tests to validate the enriched worker workflow and improved coverage.
- **API Handles DB Writes** ([#64](https://github.com/mfittko/raged/pull/64)): The API is now the sole Postgres writer while the worker talks to it via new `/internal/*` HTTP endpoints for claiming tasks, reporting results/failures, and recovering stale work, simplifying the worker and centralizing schema ownership.
- **Removed Legacy Storage Clients** ([#63](https://github.com/mfittko/raged/pull/63)): Deleted the Qdrant, Redis, and Neo4j helpers/tests, stubbed server routes while the Postgres layer stabilizes, and redirected ingest/enrichment workflows to enqueue work directly through Postgres.
- **Helm Chart Configuration Refresh** ([#61](https://github.com/mfittko/raged/pull/61)): Bumps the chart to 1.0.0, aligns the worker to talk only to the API, cleans up config maps/values, and updates docs so the chart reflects the new Postgres + optional SeaweedFS architecture.

## February 15, 2026

### Added

- **Modern Python Worker** ([#50](https://github.com/mfittko/raged/pull/50)): Introduces `pyproject.toml` with project metadata, pinned dependencies, Ruff configuration, and documentation describing its relationship to the legacy requirements files while rerunning Ruff 0.15.1 formatting/linting across every Python source. The Dockerfile now pins Python 3.12.8-slim and the lock files were regenerated for reproducible installs so the worker now ships with tighter constraints and deterministic tooling.
- **Extractor Unit Tests** ([#37](https://github.com/mfittko/raged/pull/37)): Adds dedicated tests for every extractor (article, code, email, image, meeting, pdf, and slack) so their outputs are validated against representative inputs and the extractor suite now has deterministic coverage.
- **Service Test Coverage** ([#37](https://github.com/mfittko/raged/pull/37)): Adds ingest-validation and redis unit tests with TypeScript-safe mocks, clears `vi` state between runs, and gates the work with `npm test` plus `tsc --noEmit` so validation rules and queue helpers remain reliable.
- **URL Ingestion Tests** ([#26](https://github.com/mfittko/raged/pull/26)): Added five integration tests that expand URL ingestion coverage across fetch, SSRF protection, and CLI flows so the 20 URL ingestion scenarios now guard against regressions and prove the feature works end-to-end.
- **CLI URL Ingestion Flag** ([#25](https://github.com/mfittko/raged/pull/25)): Adds a `--url` option to `rag-index ingest`, enforces mutual exclusivity with `--file`/`--dir`, and posts URL-only items to `/ingest` while surfacing the upsert results or errors in the CLI output for safer executions. The CLI now keeps strict type safety by replacing `as any` casts so URL ingestion works predictably alongside the existing flags.
- **URL Ingestion Integration Tests** ([#25](https://github.com/mfittko/raged/pull/25)): Introduces end-to-end integration coverage for HTML, PDF, text, and JSON URLs plus mixed batches, error cases (timeouts, 404s, unsupported content, SSRF), backward compatibility, and metadata verification so URL ingestion is validated holistically before release.
- **URL Fetching Ingest Pipeline** ([#24](https://github.com/mfittko/raged/pull/24)): Lets ingest requests supply URLs by making text/source optional, enforcing URL limits, and preprocessing fetch/extract/merge steps with bounded concurrency so fetched content arrives with metadata and structured errors without breaking existing text-only flows.
- **SSRF Guard Service** ([#23](https://github.com/mfittko/raged/pull/23)): Adds an SSRF guard that validates DNS resolutions, enforces CGNAT and IPv6 restrictions, and surfaces typed errors so outbound requests are blocked early for unsafe targets. Comprehensive tests now cover the full IPv6 link-local /10 range and other attack surfaces.
- **URL Fetch & Extraction** ([#23](https://github.com/mfittko/raged/pull/23)): Introduces a URL fetch pipeline with validation, deduplication, timeout/size limits, redirect-aware SSRF checks, and an O(n) concurrency pool plus content extraction for HTML, PDF, text, markdown, and JSON while preserving HTTPS/TLS validation. The new services ship with 54 guards/tests to prove both security and performance safeguards before ingestion.
- **New CLI Management Commands** ([#18](https://github.com/mfittko/raged/pull/18)): Added `rag-index ingest`, `rag-index enrich`, and `rag-index graph` commands plus the `--enrich`, `--no-enrich`, and `--doc-type` flags so ingestion, enrichment, and entity lookup workflows can be orchestrated directly from the CLI.

### Changed

- **Switch to SeaweedFS** ([#62](https://github.com/mfittko/raged/pull/62)): Updated the blob-storage design doc, Docker Compose profile, local S3 endpoint, and referenced issue to replace MinIO with the actively maintained SeaweedFS stack.
- **Worker Postgres Migration** ([#60](https://github.com/mfittko/raged/pull/60)): Rebuilt the enrichment worker to use Postgres with asyncpg/pgvector, including SKIP LOCKED dequeueing, watchdog lease recovery, and SQL-backed chunk/entity updates that preserve metadata and avoid N+1 updates, along with refreshed tests covering the new flow.
- **Infrastructure migration prep** ([#59](https://github.com/mfittko/raged/pull/59)): wired Postgres 17 with pgvector and optional MinIO into docker-compose with health checks, backward-compatible old services, configurable URLs/creds, and profile-based service groups so the stack can support the upcoming Postgres-based workflows without disrupting existing components.
- **Env docs and init scripts** ([#59](https://github.com/mfittko/raged/pull/59)): documented dual environment variables, added pgvector and MinIO initialization scripts with better error visibility and no hardcoded secrets, and expanded security guidance so operators can configure the new infrastructure safely.
- **Postgres consolidation design** ([#51](https://github.com/mfittko/raged/pull/51)): Added a detailed plan for replacing Qdrant, Neo4j, and Redis with a single PostgreSQL/pgvector setup, covering schemas, task queue handling, and MinIO blob support plus migration ordering dependencies on upcoming phases.
- **CLI Tests in CI** ([#49](https://github.com/mfittko/raged/pull/49)): Adds CLI command coverage to the CI matrix with a dependency on the coverage suite so every run now exercises CLI workflows while guarding the coverage thresholds above 60%.
- **Structured Logger Errors** ([#49](https://github.com/mfittko/raged/pull/49)): `logger.error` now routes non-Error payloads through `console.dir` so the CLI surfaces readable object details instead of `[object Object]`, and a regression test confirms the formatted output is printed for complex payloads.
- **Worker CI Reliability** ([#48](https://github.com/mfittko/raged/pull/48)): Resolved the worker lint and test failures by fixing unused imports/variables, adding the necessary noqa, ruff-formatting every worker file, correcting the mock signature, and addressing mutable defaults so the entire suite now passes locally and in CI.
- **Worker Dependency Cleanup** ([#48](https://github.com/mfittko/raged/pull/48)): Split dev/test requirements from runtime dependencies and added cache-dependency-paths so both requirement files cache pip installs properly, reducing the production dependency surface while speeding up CI runs.
- **Production Security Hardening** ([#36](https://github.com/mfittko/raged/pull/36)): Hardened deployments by enforcing non-root containers, security contexts, resource defaults, and ephemeral volumes while adding Helm-aware API protections (CORS, rate limiting, trust proxy) plus dependency-aware liveness probes and validation so production deployments run securely and reliably.
- **Document URL Ingestion** ([#26](https://github.com/mfittko/raged/pull/26)): Expanded architecture, local-dev, troubleshooting, API reference, and README content to describe the URL-based ingest workflow, CLI `--url` usage, and security/testing guidance so documentation now matches the implemented capability and helps developers adopt it accurately.
- **Align docs with Issue #10** ([#19](https://github.com/mfittko/raged/pull/19)): Updated the README and vision/architecture guides to drop “planned” language and reflect the implemented enrichment/graph stack, and refreshed local dev, Helm, and troubleshooting docs with the Redis/worker/Neo4j topology, configuration examples, and failure checks for the new features.

### Fixed

- **Numeric CLI Options** ([#49](https://github.com/mfittko/raged/pull/49)): Validates `--maxFiles` and `--maxBytes` as finite positive numbers, fails fast with exit code 2, and tests invalid input so users no longer produce NaN values with non-numeric or out-of-range flags.
- **Log Empty Catch Blocks** ([#37](https://github.com/mfittko/raged/pull/37)): Replaces empty catch blocks with debug logging, sanitizes SSRF error messages to avoid exposing credentials, and removes noisy fallback logging so upstream errors surface without leaking secrets.
- **Quote Mermaid Label** ([#28](https://github.com/mfittko/raged/pull/28)): Wraps the Mermaid edge label in quotes so parentheses are treated as literal characters, preventing parser errors and allowing the README diagram to render reliably.
- **Network Error Test** ([#26](https://github.com/mfittko/raged/pull/26)): Aligned the network error integration test with production behavior by expecting `fetch_failed` plus `status: null`, correcting the TypeScript linting error and keeping the suite passing while reflecting actual error reporting.

## February 14, 2026

### Added

- **Enrichment Monitoring Endpoints** ([#13](https://github.com/mfittko/raged/pull/13)): Adds chunk status, stats, enqueue, graph entity, and graph-expanded query endpoints so enrichment progress and graph retrieval are fully surfaced through the API.
- **Automated Enrichment Pipeline** ([#12](https://github.com/mfittko/raged/pull/12)): Builds the full three-phase worker infrastructure with Docker Compose, tiered metadata extractors, pluggable LLM adapters, document schemas, and end-to-end pipeline tests so documents are automatically detected, enriched, and queued for processing.
- **Knowledge Graph Integration** ([#12](https://github.com/mfittko/raged/pull/12)): Adds Neo4j client operations plus entity and relationship schema routers with validation tests with so enriched metadata is persisted into the knowledge graph for downstream consumption.
- **Metadata Extraction Foundation** ([#11](https://github.com/mfittko/raged/pull/11)): Adds Redis, Neo4j, and worker infrastructure plus Tier-1 document detection/extraction in `/ingest`, Helm charts, and CI/security fixes so metadata is auto-enriched and queued for future knowledge graph retrieval.
- **Metadata Extraction Blueprint** ([#9](https://github.com/mfittko/raged/pull/9)): Adds design and implementation plan docs detailing tiered metadata extraction, Neo4j knowledge graph enrichment, LLM adapters, and the 20-task coding-agent executable plan for orchestrating ingestion and retrieval infrastructure.
- **Multi-Agent Hub Plan** ([#6](https://github.com/mfittko/raged/pull/6)): Documents the v2.0 multi-agent hub plan with a 14-task, 103-test TDD roadmap that modernizes rag-stack with tenant-aware APIs, key management, namespaced collections, federated search, SDKs, and observability/deployment scaffolding so multi-tenant deployments can be built consistently.
- **v2 Knowledge Graph Plan** ([#5](https://github.com/mfittko/raged/pull/5)): Introduces the v2.0 knowledge graph plan with 12 TDD tasks outlining async entity extraction, GraphRAG hybrid retrieval, extractor strategies, entity persistence in Qdrant, and the new `GET /v1/entities` endpoint so relationship tracking is automated and reranking leverages shared entities.
- **Graph Layer Plan** ([#4](https://github.com/mfittko/raged/pull/4)): Documents the TDD-based v1.0 graph layer plan with nine tasks and ~55 tests, defines GraphEdge/LinkType/GraphStore interfaces, and lays out Qdrant adjacency-list graph storage plus POST/GET/DELETE link endpoints, graph-aware query expansion, bulk ingest support, and updated documentation so relationship tracking can be introduced without a separate graph database dependency.
- **v1.0 Hardening Plan** ([#3](https://github.com/mfittko/raged/pull/3)): Summarizes the production hardening strategy with a 12-task, ~52-test TDD plan covering swappable embedding/vector factories, rate limiting, structured logging, API versioning, and enhanced health checks so v1.0 can roll out reliably. Highlights the adapter pattern for embedding providers and vector backends and notes the dependency on the v0.5 standards plan for AGENTS compliance before implementation.
- **v0.5 Standards Plan** ([#2](https://github.com/mfittko/raged/pull/2)): Adds the v0.5 implementation plan outlining tasks to close AGENTS.md compliance gaps for API, CLI, testing, and CI so future PRs can follow a coordinated strategy.
- **OpenClaw Semantic Skill** ([#1](https://github.com/mfittko/raged/pull/1)): Introduces the OpenClaw AgentSkill that exposes rag-stack as a semantic knowledge base, letting you ingest any text content (code, docs, articles, emails, transcripts) and query it via natural language.
- **Connectivity Checker Script** ([#1](https://github.com/mfittko/raged/pull/1)): Adds a TDD-built `check-connection.mjs` script with five passing tests to perform pre-flight health validation before using the skill.

### Changed

- **Graph API Documentation** ([#13](https://github.com/mfittko/raged/pull/13)): Documents the `ENRICHMENT_ENABLED` environment variable and aligns the `/graph/entity/:name` examples with the actual `entity`, `relationship`, and `direction` fields so the API reference matches runtime behavior.
- **Standards Compliance Overhaul** ([#8](https://github.com/mfittko/raged/pull/8)): Adds Vitest unit and integration tests, extracts ingest/query services, enforces JSON Schema validation, structured errors, and batched embeddings so the API aligns with AGENTS standards and scales reliably.
- **CI and Docker Stabilization** ([#8](https://github.com/mfittko/raged/pull/8)): Updates GitHub Actions to run the new test suite, adds `.env.example`, fixes Docker’s tsconfig.build and entry point, and ensures the container builds and runs the validated API.
- **Skill Documentation** ([#1](https://github.com/mfittko/raged/pull/1)): Ships SKILL.md with schema and usage guides, references/REFERENCE.md, and expanded README guidance detailing ingestion/query flows, CLI instructions, and error handling for the new skill.

### Fixed

- **Performance Violations Remediated** ([#17](https://github.com/mfittko/raged/pull/17)): Caps ingest/code extractor outputs, converts entity expansion to map lookups, adds required Qdrant/Neo4j/baseId indexes, batches streaming/enqueue work, and tightens parsing guards so the service eliminates O(n²)/N+1/memory violations and meets AGENTS performance requirements.
- **Enrichment Test Safety** ([#13](https://github.com/mfittko/raged/pull/13)): Ensures `result.metadata` is defined before evaluating enrichment test expectations so TypeScript compilation no longer reports possible undefined errors.

