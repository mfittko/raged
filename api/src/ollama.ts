const EMBED_MODEL = process.env.EMBED_MODEL || "nomic-embed-text";

function getOllamaUrl(): string {
  const ollamaUrl = process.env.OLLAMA_URL;
  if (!ollamaUrl) {
    throw new Error("OLLAMA_URL is required for embedding generation");
  }
  return ollamaUrl;
}

async function embedOne(text: string): Promise<number[]> {
  const ollamaUrl = getOllamaUrl();

  const res = await fetch(`${ollamaUrl}/api/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, prompt: text }),
  });
  if (!res.ok) {
    const err = new Error(`Ollama embeddings failed: ${res.status} ${await res.text()}`) as Error & { code: string };
    err.code = "UPSTREAM_SERVICE_ERROR";
    throw err;
  }
  const json = (await res.json()) as { embedding: number[] };
  return json.embedding;
}

export async function embed(texts: string[], concurrency = 10): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("concurrency must be a positive integer");
  }

  const results: number[][] = new Array(texts.length);

  for (let i = 0; i < texts.length; i += concurrency) {
    const batch = texts.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map((text) => embedOne(text)));
    for (let j = 0; j < batchResults.length; j++) {
      results[i + j] = batchResults[j];
    }
  }

  return results;
}
