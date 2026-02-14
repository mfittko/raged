# Agent Integrations

rag-stack is agent-agnostic. Any agent that can call HTTP or execute shell commands can use it as a knowledge base. This page covers built-in integrations.

## Claude Code

### How It Works

```mermaid
sequenceDiagram
    participant U as User
    participant C as Claude Code
    participant S as rag-memory Skill
    participant CLI as rag-index CLI
    participant API as RAG API

    U->>C: "How does auth work in project X?"
    C->>S: Invoke skill
    S->>CLI: rag-index query --q "auth" --topK 5
    CLI->>API: POST /query
    API-->>CLI: Relevant chunks
    CLI-->>S: Formatted results
    S-->>C: Context injected
    C-->>U: Grounded answer with references
```

### Skill Location

```
.claude/skills/rag-memory/SKILL.md
```

### Setup

**Local** (Docker Compose on the same machine):

```bash
# No configuration needed — defaults work
# API at http://localhost:8080, no auth
```

**Remote:**

```bash
export RAG_API_URL=https://rag.example.com
export RAG_API_TOKEN=your-token-here
```

### Usage

The skill is invoked automatically when Claude determines it needs context. You can also ask directly:

> "Use rag-memory to find how authentication is implemented in the fastify-docs collection"

Claude will run:
```bash
rag-index query \
  --api "${RAG_API_URL:-http://localhost:8080}" \
  --q "authentication implementation" \
  --topK 5 \
  --token "${RAG_API_TOKEN:-}"
```

## OpenClaw

### How It Works

```mermaid
sequenceDiagram
    participant U as User
    participant OC as OpenClaw
    participant S as rag-stack Skill
    participant API as RAG API

    U->>OC: "Find docs about deployment strategy"
    OC->>S: Activate skill
    S->>API: POST /query (via curl)
    API-->>S: Relevant chunks
    S-->>OC: Results formatted
    OC-->>U: Grounded answer with sources
```

### Skill Location

```
~/.openclaw/skills/rag-stack/SKILL.md
```

### Setup

Install the skill (from the rag-stack repo):

```bash
ln -s /path/to/rag-stack/skill ~/.openclaw/skills/rag-stack
```

Configure in `~/.openclaw/openclaw.json`:

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

### Usage

OpenClaw activates the skill based on the description in SKILL.md. The agent uses `curl` to call the rag-stack API directly.

## Other Agents

Any agent that can call HTTP or execute shell commands can use rag-stack:

```bash
# Via CLI
rag-index query --api <url> --q "<question>" --topK 5

# Via HTTP API
curl -X POST https://rag.example.com/query \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"query": "authentication flow", "topK": 5}'
```

The v2.0 roadmap includes native SDK/client libraries for TypeScript, Python, and Go — eliminating the CLI dependency.
