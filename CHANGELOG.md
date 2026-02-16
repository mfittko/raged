# Changelog

All notable changes to this project are documented in this file.

The entries are backfilled from closed pull requests.

---

## February 16, 2026

### Changed

- **Rename project: rag-stack → raged** ([#67](https://github.com/mfittko/raged/pull/67))
- **Migrate API services to Postgres (ingest, query, enrichment + worker endpoints)** ([#65](https://github.com/mfittko/raged/pull/65))
- **docs: API as sole DB gateway — worker via internal HTTP endpoints** ([#64](https://github.com/mfittko/raged/pull/64))
- **PG 2/6: Database layer and schema migrations** ([#63](https://github.com/mfittko/raged/pull/63))
- **Helm chart: Replace Qdrant/Redis/Neo4j with Postgres + pgvector** ([#61](https://github.com/mfittko/raged/pull/61))

## February 15, 2026

### Changed

- **docs: replace MinIO with SeaweedFS for blob storage** ([#62](https://github.com/mfittko/raged/pull/62))
- **PG 4/6: Migrate worker to Postgres — SKIP LOCKED dequeue + entity storage** ([#60](https://github.com/mfittko/raged/pull/60))
- **PG 1/6: Replace Qdrant/Redis/Neo4j with Postgres 17 + pgvector** ([#59](https://github.com/mfittko/raged/pull/59))
- **docs: Postgres consolidation design** ([#51](https://github.com/mfittko/raged/pull/51))
- **Modernize Python worker: add pyproject.toml, ruff, pin versions** ([#50](https://github.com/mfittko/raged/pull/50))
- **Add CLI tests to CI matrix with coverage dependency** ([#49](https://github.com/mfittko/raged/pull/49))
- **Fix worker CI jobs: resolve test failure, linting issues, and add pip caching** ([#48](https://github.com/mfittko/raged/pull/48))
- **Add test coverage for extractors, ingest-validation, redis; fix empty catch blocks** ([#37](https://github.com/mfittko/raged/pull/37))
- **Security hardening: non-root containers, API protection, Helm best practices** ([#36](https://github.com/mfittko/raged/pull/36))
- **Fix Mermaid diagram parse error in README** ([#28](https://github.com/mfittko/raged/pull/28))
- **docs: Document URL-based ingestion feature** ([#26](https://github.com/mfittko/raged/pull/26))
- **feat: CLI --url flag + integration tests for URL ingestion** ([#25](https://github.com/mfittko/raged/pull/25))
- **[WIP] Integrate URL fetching into ingest pipeline** ([#24](https://github.com/mfittko/raged/pull/24))
- **feat: URL fetch service with SSRF guard** ([#23](https://github.com/mfittko/raged/pull/23))
- **[WIP] Update documentation to finalize Issue #10 alignment** ([#19](https://github.com/mfittko/raged/pull/19))
- **feat: CLI enhancements and documentation for metadata extraction & knowledge graph (v1.0)** ([#18](https://github.com/mfittko/raged/pull/18))

## February 14, 2026

### Changed

- **perf: remediate 20 performance violations (O(n²), N+1, memory, indexes)** ([#17](https://github.com/mfittko/raged/pull/17))
- **feat: enrichment monitoring and graph-based retrieval endpoints** ([#13](https://github.com/mfittko/raged/pull/13))
- **Add automatic metadata extraction and knowledge graph (Phase 1-3)** ([#12](https://github.com/mfittko/raged/pull/12))
- **feat: metadata extraction & knowledge graph foundation (phases 1-2)** ([#11](https://github.com/mfittko/raged/pull/11))
- **docs: metadata extraction & knowledge graph design + implementation plan** ([#9](https://github.com/mfittko/raged/pull/9))
- **v0.5: Fix standards compliance violations** ([#8](https://github.com/mfittko/raged/pull/8))
- **docs: v2.0 multi-agent hub plan** ([#6](https://github.com/mfittko/raged/pull/6))
- **docs: v2.0 knowledge graph plan** ([#5](https://github.com/mfittko/raged/pull/5))
- **docs: v1.0 graph layer plan** ([#4](https://github.com/mfittko/raged/pull/4))
- **docs: v1.0 production hardening plan** ([#3](https://github.com/mfittko/raged/pull/3))
- **docs: v0.5 standards compliance plan** ([#2](https://github.com/mfittko/raged/pull/2))
- **feat: add OpenClaw AgentSkill for semantic knowledge base** ([#1](https://github.com/mfittko/raged/pull/1))
