import { embedWithOllama } from "./embeddings-ollama.js";
import { embedWithOpenAi } from "./embeddings-openai.js";

type EmbedProvider = "ollama" | "openai";

function getEmbedProvider(): EmbedProvider {
  const rawProvider = (process.env.EMBED_PROVIDER || "ollama").trim().toLowerCase();
  if (rawProvider === "openai") {
    return "openai";
  }
  return "ollama";
}

async function embedOne(text: string): Promise<number[]> {
  const provider = getEmbedProvider();
  if (provider === "openai") {
    return embedWithOpenAi(text);
  }
  return embedWithOllama(text);
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
