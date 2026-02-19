type EmbedProvider = "ollama" | "openai";

const OLLAMA_EMBED_MODEL = process.env.EMBED_MODEL || "nomic-embed-text";
const OPENAI_EMBEDDING_MODEL = process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";

function getEmbedProvider(): EmbedProvider {
  const rawProvider = (process.env.EMBED_PROVIDER || "ollama").trim().toLowerCase();
  if (rawProvider === "openai") {
    return "openai";
  }
  return "ollama";
}

function getOllamaUrl(): string {
  const ollamaUrl = process.env.OLLAMA_URL;
  if (!ollamaUrl) {
    throw new Error("OLLAMA_URL is required for embedding generation");
  }
  return ollamaUrl;
}

function getOpenAiApiKey(): string {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required when EMBED_PROVIDER=openai");
  }
  return apiKey;
}

function getOpenAiBaseUrl(): string {
  const configuredUrl = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
  return configuredUrl.replace(/\/+$/, "");
}

function ensureEmbeddingArray(value: unknown, context: string): number[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "number")) {
    throw new Error(`Invalid embedding payload from ${context}`);
  }
  return value;
}

async function embedOne(text: string): Promise<number[]> {
  const provider = getEmbedProvider();

  if (provider === "openai") {
    const openAiBaseUrl = getOpenAiBaseUrl();
    const apiKey = getOpenAiApiKey();

    const res = await fetch(`${openAiBaseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model: OPENAI_EMBEDDING_MODEL, input: text }),
    });

    if (!res.ok) {
      const err = new Error(`OpenAI embeddings failed: ${res.status} ${await res.text()}`) as Error & { code: string };
      err.code = "UPSTREAM_SERVICE_ERROR";
      throw err;
    }

    const json = (await res.json()) as { data?: Array<{ embedding?: unknown }> };
    const embedding = json.data?.[0]?.embedding;
    return ensureEmbeddingArray(embedding, "OpenAI");
  }

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
  return ensureEmbeddingArray(json.embedding, "Ollama");
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
