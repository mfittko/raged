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
          "RAGED_URL": "http://localhost:8080",
          "RAGED_TOKEN": ""
        }
      }
    }
  }
}
```

Set `RAGED_TOKEN` only if your raged instance has `RAGED_API_TOKEN` configured.

## Prerequisites

1. A running raged instance: `docker compose up -d` (from the raged repo)
2. `curl` on PATH
3. The Ollama embedding model pulled: `curl http://localhost:11434/api/pull -d '{"name":"nomic-embed-text"}'`

## Verify

```bash
# In an OpenClaw session, ask:
"Is raged running?"
# The agent will call /healthz and report status.
```
