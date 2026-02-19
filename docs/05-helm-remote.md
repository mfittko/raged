# Helm Deployment (Remote)

Deploy raged to Kubernetes with Ingress and token authentication.

## Deployment Topology

### Base Stack

```mermaid
graph TD
    subgraph Internet
        AG[AI Agents]
    end

    subgraph Kubernetes Cluster
        ING[Ingress<br/>TLS termination] --> SVC[API Service<br/>ClusterIP]
        SVC --> API1[API Pod 1]
        SVC --> API2[API Pod 2]
        API1 --> PG[Postgres<br/>StatefulSet]
        API2 --> PG
        API1 --> OL[Ollama<br/>Deployment]
        API2 --> OL
    end

    AG -->|HTTPS| ING

    style ING fill:#fff3e0
    style PG fill:#f3e5f5
    style OL fill:#e8f5e9
```

### Full Stack (with Enrichment)

```mermaid
graph TD
    subgraph Internet
        AG[AI Agents]
    end

    subgraph Kubernetes Cluster
        ING[Ingress<br/>TLS termination] --> SVC[API Service<br/>ClusterIP]
        SVC --> API1[API Pod 1]
        SVC --> API2[API Pod 2]
        API1 --> PG[Postgres<br/>StatefulSet]
        API2 --> PG
        API1 --> OL[Ollama<br/>Deployment]
        API2 --> OL
        WK[Worker<br/>Deployment] --> PG
        WK --> OL
    end

    AG -->|HTTPS| ING

    style ING fill:#fff3e0
    style PG fill:#f3e5f5
    style OL fill:#e8f5e9
    style WK fill:#e0f2f1
```

## Prerequisites

- Kubernetes cluster with an Ingress controller
- `helm` CLI (v3.15+)
- Container registry access

## Build & Push Images

Official images are automatically published to GitHub Container Registry (GHCR) from this repository:

- **API:** `ghcr.io/mfittko/raged-api`
- **CLI/Indexer:** `ghcr.io/mfittko/raged`
- **Worker:** `ghcr.io/mfittko/raged-worker`

Images are published on:
- Every push to `main` (tagged with `main` and `sha-<commit>`)
- Every version tag (e.g., `v0.6.0` creates tags `0.6.0`, `0.6`, `0`, and `latest`)

For custom builds:

```bash
# API
docker build -t ghcr.io/mfittko/raged-api:custom ./api
docker push ghcr.io/mfittko/raged-api:custom

# CLI (for in-cluster indexing)
docker build -t ghcr.io/mfittko/raged:custom ./cli
docker push ghcr.io/mfittko/raged:custom
```

## Install

### Base Stack (Vector Search Only)

```bash
helm install rag ./chart -n rag --create-namespace \
  --set api.ingress.enabled=true \
  --set api.ingress.host=raged.example.com \
  --set api.auth.enabled=true \
  --set api.auth.token=REPLACE_ME
```

*Note: The chart now defaults to official GHCR images. Override with `--set api.image.repository` and `--set api.image.tag` if needed.*

### Full Stack (with Enrichment & Knowledge Graph)

```bash
# Install with enrichment enabled
helm install rag ./chart -n rag --create-namespace \
  --set api.ingress.enabled=true \
  --set api.ingress.host=raged.example.com \
  --set api.auth.enabled=true \
  --set api.auth.token=REPLACE_ME \
  --set enrichment.enabled=true \
  --set postgres.auth.password=REPLACE_POSTGRES_PASSWORD
```

*Note: Worker images are published to GHCR automatically. Custom worker builds can override with `--set enrichment.worker.image.repository` and `--set enrichment.worker.image.tag`.*

## Key Values

### Core Configuration

| Value | Default | Description |
|-------|---------|-------------|
| `api.replicas` | `2` | Number of API pods |
| `api.ingress.enabled` | `false` | Enable Ingress |
| `api.ingress.host` | `raged.local` | Ingress hostname |
| `api.ingress.tls.enabled` | `false` | Enable TLS |
| `api.auth.enabled` | `true` | Enable bearer token auth |
| `api.auth.token` | `""` | Auth token (set this!) |
| `postgres.storage.size` | `20Gi` | Postgres persistent volume size |
| `ollama.enabled` | `true` | Deploy Ollama in-cluster |
| `ollama.storage.size` | `30Gi` | Ollama model storage size |
| `indexer.enabled` | `false` | Enable in-cluster indexing Job |

### Enrichment Configuration

| Value | Default | Description |
|-------|---------|-------------|
| `enrichment.enabled` | `false` | Enable enrichment stack (worker) |
| `enrichment.worker.replicas` | `1` | Number of enrichment worker pods |
| `enrichment.worker.concurrency` | `4` | Concurrent tasks per worker |
| `enrichment.worker.extractor.provider` | `auto` | LLM provider: `auto`, `ollama`, `anthropic`, or `openai` |
| `enrichment.worker.extractor.openaiBaseUrl` | `https://api.openai.com/v1` | OpenAI-compatible completion base URL |
| `enrichment.worker.extractor.modelFast` | `llama3` | Fast model for high-throughput extraction |
| `enrichment.worker.extractor.modelCapable` | `llama3` | Capable model for complex extraction |
| `enrichment.worker.extractor.modelVision` | `llava` | Vision model for image-based extraction |
| `postgres.auth.password` | `""` | Postgres password (set in production!) |

With `enrichment.worker.extractor.provider=auto`, the worker picks `openai` when `openaiApiKey` is set, otherwise `anthropic` when `anthropicApiKey` is set, and falls back to `ollama`.

Extraction requests use OpenAI-compatible chat completions. Set
`enrichment.worker.extractor.provider=openai` and override
`enrichment.worker.extractor.openaiBaseUrl` to switch compatible providers.

See [values.yaml](../chart/values.yaml) for the full list.

## Upgrade

```bash
helm upgrade rag ./chart -n rag \
  --set api.image.tag=0.6.0 \
  --reuse-values
```

To upgrade to a specific version from GHCR:

```bash
helm upgrade rag ./chart -n rag \
  --set api.image.tag=0.6.0 \
  --set enrichment.worker.image.tag=0.6.0 \
  --reuse-values
```

## TLS

```bash
helm install rag ./chart -n rag --create-namespace \
  --set api.ingress.enabled=true \
  --set api.ingress.host=raged.example.com \
  --set api.ingress.tls.enabled=true \
  --set api.ingress.tls.secretName=raged-tls
```

Ensure a TLS certificate Secret exists in the `rag` namespace, or use cert-manager to provision one automatically.
