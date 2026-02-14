# Remote deployment (Helm + Ingress + token)

## Build & push images
```bash
docker build -t your-registry/rag-api:0.5.0 ./api
docker push your-registry/rag-api:0.5.0

docker build -t your-registry/rag-index:0.5.0 ./cli
docker push your-registry/rag-index:0.5.0
```

## Install (Ingress + token)
```bash
helm install rag ./chart -n rag --create-namespace \
  --set api.image.repository=your-registry/rag-api \
  --set api.image.tag=0.5.0 \
  --set api.ingress.enabled=true \
  --set api.ingress.host=rag.example.com \
  --set api.auth.enabled=true \
  --set api.auth.token=REPLACE_ME
```
