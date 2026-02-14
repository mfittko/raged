# rag-stack OpenClaw Skill

An [OpenClaw](https://openclaw.ai/) AgentSkill that gives your agent semantic
code search over indexed Git repositories.

## Install

### Option A: Symlink (development)

```bash
ln -s /path/to/rag-stack/skill ~/.openclaw/skills/rag-stack
```

### Option B: Copy

```bash
cp -r /path/to/rag-stack/skill ~/.openclaw/skills/rag-stack
```

## Configure

Add to `~/.openclaw/openclaw.json`:

```json
{
  "skills": {
    "entries": {
      "rag-stack": {
        "enabled": true,
        "env": {
          "RAG_STACK_URL": "http://localhost:8080",
          "RAG_STACK_TOKEN": ""
        }
      }
    }
  }
}
```

Set `RAG_STACK_TOKEN` only if your rag-stack instance has `RAG_API_TOKEN` configured.

## Prerequisites

1. A running rag-stack instance: `docker compose up -d` (from the rag-stack repo)
2. `curl` on PATH
3. The Ollama embedding model pulled: `curl http://localhost:11434/api/pull -d '{"name":"nomic-embed-text"}'`

## Verify

```bash
# In an OpenClaw session, ask:
"Is rag-stack running?"
# The agent will call /healthz and report status.
```
