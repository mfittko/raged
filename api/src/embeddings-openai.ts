const OPENAI_EMBEDDING_MODEL = process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";

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

function ensureEmbeddingArray(value: unknown): number[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "number")) {
    throw new Error("Invalid embedding payload from OpenAI");
  }
  return value;
}

export async function embedWithOpenAi(text: string): Promise<number[]> {
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
  return ensureEmbeddingArray(json.data?.[0]?.embedding);
}