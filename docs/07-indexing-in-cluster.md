# Indexing inside the cluster (Job)

Enable the indexer Job (Helm hook) to run indexing near your cluster:

```bash
helm upgrade --install rag ./chart -n rag --create-namespace \
  --set api.image.repository=your-registry/rag-api \
  --set api.image.tag=0.5.0 \
  --set api.auth.enabled=true \
  --set api.auth.token=REPLACE_ME \
  --set indexer.enabled=true \
  --set indexer.image.repository=your-registry/rag-index \
  --set indexer.image.tag=0.5.0 \
  --set indexer.repoUrl=https://github.com/<org>/<repo>.git \
  --set indexer.repoId=<stable-id> \
  --set indexer.branch=main
```

Notes:
- For private repos, mount SSH keys as a Secret in a follow-up iteration.
