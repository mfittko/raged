const OLLAMA_URL = process.env.OLLAMA_URL || "http://ollama:11434";
const EMBED_MODEL = process.env.EMBED_MODEL || "nomic-embed-text";

export async function embed(texts: string[]): Promise<number[][]> {
  const vectors: number[][] = [];
  for (const input of texts) {
    const res = await fetch(`${OLLAMA_URL}/api/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: EMBED_MODEL, prompt: input }),
    });
    if (!res.ok) throw new Error(`Ollama embeddings failed: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as any;
    vectors.push(json.embedding);
  }
  return vectors;
}
