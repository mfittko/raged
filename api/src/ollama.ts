const OLLAMA_URL = process.env.OLLAMA_URL || "http://ollama:11434";
const EMBED_MODEL = process.env.EMBED_MODEL || "nomic-embed-text";

async function embedOne(text: string): Promise<number[]> {
  const res = await fetch(`${OLLAMA_URL}/api/embeddings`, {
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
