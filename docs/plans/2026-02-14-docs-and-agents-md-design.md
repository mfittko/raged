# Documentation Expansion & Layered AGENTS.md — Design Document

**Date:** 2026-02-14
**Status:** Approved

## Goal

Expand raged documentation to reflect the full project vision (multi-agent memory hub), add Mermaid diagrams throughout, and create layered `AGENTS.md` files that guide AI coding agents with principles and concrete rules.

## Approach

**AGENTS.md first, then docs.** The AGENTS.md files establish how work gets done in this repo. The documentation expansion follows those principles, serving as the first "test" of the guidance.

## Phase 1: Layered AGENTS.md (5 files)

### `/AGENTS.md` — Project-wide Principles

High-level guidance that applies everywhere:

- **Project identity:** raged is a multi-agent memory hub — a shared memory layer for AI coding agents backed by vector search
- **Core principles:** SOLID, KISS, DRY, SRP, YAGNI — each with a one-liner and a concrete "in this project, that means..." example
- **TypeScript conventions:** strict mode, ES modules, no `any`, prefer interfaces for public APIs
- **Git conventions:** conventional commits, small focused PRs, no force-push to main
- **Testing philosophy:** TDD, unit tests for logic, integration tests for API routes, no tests for trivial getters
- **Architecture guardrails:** stateless API, all state in Qdrant, no ORM, keep dependencies minimal
- **Security baseline:** never log tokens, validate at boundaries, timing-safe comparisons

### `cli/AGENTS.md` — CLI Rules

- CLI is a thin orchestrator — no business logic, just coordination
- All HTTP calls go through a typed client module
- Every command must have `--help` output
- Error messages must be actionable (not just "failed")
- File scanning respects `.gitignore` patterns

### `api/AGENTS.md` — API Rules

- Fastify plugins for cross-cutting concerns (auth, logging)
- Route handlers stay thin — delegate to service modules
- Every route must validate input with JSON Schema
- Chunking, embedding, and vector ops are separate modules (SRP)
- Health endpoint (`/healthz`) must always be unauthenticated

### `chart/AGENTS.md` — Helm Chart Rules

- All values must have defaults in `values.yaml`
- Secrets never have default values
- Use `_helpers.tpl` for repeated label blocks (DRY)
- Every template must be lintable (`helm lint`)

### `docs/AGENTS.md` — Documentation Rules

- Tone: concise, direct, technical
- Every architecture or flow explanation includes a Mermaid diagram
- Use consistent heading hierarchy (H1 = title, H2 = sections, H3 = subsections)
- Code examples must be copy-pasteable and complete
- Keep docs DRY — link instead of duplicating

## Phase 2: Documentation Expansion (11 files)

### New Documents

| File | Purpose |
|------|---------|
| `docs/00-vision.md` | Project vision: multi-agent memory hub, roadmap phases (MVP → v1.0 → v2.0), success criteria |
| `docs/08-contributing.md` | Contributor guide: dev setup, PR process, code style, testing requirements |
| `docs/09-api-reference.md` | Full API reference: all endpoints with request/response examples |

### Polished Existing Documents

| File | Changes |
|------|---------|
| `README.md` | Vision statement, Mermaid architecture diagram, badges, structured links to full docs |
| `docs/01-architecture.md` | Mermaid component diagram, data flow diagram, security model diagram |
| `docs/02-local-dev.md` | Mermaid sequence diagram for local dev startup flow |
| `docs/03-cli.md` | Command reference table, Mermaid flow for index/query lifecycle |
| `docs/04-claude-skills.md` | Expanded usage examples, multi-agent integration context |
| `docs/05-helm-remote.md` | Mermaid deployment topology diagram (local vs K8s) |
| `docs/06-troubleshooting.md` | More scenarios, Mermaid decision tree for debugging |
| `docs/07-indexing-in-cluster.md` | Mermaid sequence diagram for in-cluster indexing flow |

### Mermaid Diagrams Planned

- **Architecture overview** (graph): API ↔ Qdrant ↔ Ollama ↔ CLI ↔ Agents
- **Index data flow** (sequence): CLI → API → chunk → embed → upsert
- **Query data flow** (sequence): Agent → CLI → API → embed → search → results
- **Deployment topology** (graph): local Docker Compose vs. Kubernetes
- **Security model** (flowchart): token auth flow through API
- **Roadmap** (timeline): MVP → v1.0 → v2.0 milestones

## Vision: Multi-Agent Memory Hub

raged evolves from a CLI+API MVP into a shared memory layer for any AI coding agent:

- **v0.5 (current):** CLI indexer + Fastify API + Qdrant + Ollama, Claude Code skill
- **v1.0:** Auth/multi-tenancy, multiple embedding providers, plugin architecture for agents
- **v2.0:** Federated memory (cross-project search), agent collaboration, real-time sync

## Architecture Principles

These are codified in the root AGENTS.md and enforced in subfolder AGENTS.md files:

- **Single Responsibility:** Each module does one thing (chunking, embedding, vector ops, auth)
- **Open/Closed:** New embedding providers or vector DBs via adapters, not by modifying core
- **Dependency Inversion:** Core logic depends on abstractions, not on Qdrant/Ollama directly
- **KISS:** No premature abstractions — extract when the third use case appears
- **DRY:** Shared types in a common location, `_helpers.tpl` for Helm, link instead of copy in docs
- **YAGNI:** Don't build multi-tenancy until it's needed — but design so it's possible
