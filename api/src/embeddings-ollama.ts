const OLLAMA_EMBED_MODEL = process.env.EMBED_MODEL || "nomic-embed-text";

function getOllamaUrl(): string {
  const ollamaUrl = process.env.OLLAMA_URL;
  if (!ollamaUrl) {
    throw new Error("OLLAMA_URL is required for embedding generation");
  }
  return ollamaUrl;
}

function ensureEmbeddingArray(value: unknown): number[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "number")) {
    throw new Error("Invalid embedding payload from Ollama");
  }
  return value;
}

export async function embedWithOllama(text: string): Promise<number[]> {
  const ollamaUrl = getOllamaUrl();

  const res = await fetch(`${ollamaUrl}/api/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: OLLAMA_EMBED_MODEL, prompt: text }),
  });

  if (!res.ok) {
    const err = new Error(`Ollama embeddings failed: ${res.status} ${await res.text()}`) as Error & { code: string };
    err.code = "UPSTREAM_SERVICE_ERROR";
    throw err;
  }

  const json = (await res.json()) as { embedding?: unknown };
  return ensureEmbeddingArray(json.embedding);
}