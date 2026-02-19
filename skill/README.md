# raged OpenClaw Skill

An [OpenClaw](https://openclaw.ai/) AgentSkill that gives your agent a semantic
knowledge base — ingest code, docs, articles, emails, transcripts, or any text
and retrieve relevant context via natural-language queries.

## Install

### Option A: Symlink (development)

```bash
ln -s /path/to/raged/skill ~/.openclaw/skills/raged
```

### Option B: Copy

```bash
cp -r /path/to/raged/skill ~/.openclaw/skills/raged
```

## Configure

Add to `~/.openclaw/openclaw.json`:

```json
{
  "skills": {
    "entries": {
      "raged": {
        "enabled": true,
        "env": {
          "RAGED_URL": "http://localhost:39180",
          "RAGED_TOKEN": ""
        }
      }
    }
  }
}
```

Set `RAGED_TOKEN` only if your raged instance has `RAGED_API_TOKEN` configured.

## Prerequisites

1. A running raged instance (example with custom ports): `POSTGRES_HOST_PORT=26532 API_HOST_PORT=39180 docker compose up -d postgres api` (from the raged repo)
2. `curl` on PATH
3. Embedding provider configured for your API:
  - OpenAI: set `OPENAI_API_KEY`
  - Local OpenAI-compatible endpoint (e.g., Ollama): set `OPENAI_BASE_URL` and `OPENAI_API_KEY` (any non-empty value for local endpoints)

## Verify

```bash
# In an OpenClaw session, ask:
"Is raged running?"
# The agent will call /healthz and report status.
```
