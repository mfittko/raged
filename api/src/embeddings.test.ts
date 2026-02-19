import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { embed } from "./embeddings.js";

const originalFetch = globalThis.fetch;

describe("embed", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const originalOllamaUrl = process.env.OLLAMA_URL;
  const originalEmbedProvider = process.env.EMBED_PROVIDER;
  const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
  const originalOpenAiBaseUrl = process.env.OPENAI_BASE_URL;
  const originalOpenAiEmbeddingModel = process.env.OPENAI_EMBEDDING_MODEL;

  beforeEach(() => {
    process.env.OLLAMA_URL = "http://localhost:11434";
    delete process.env.EMBED_PROVIDER;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_EMBEDDING_MODEL;
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as any;
  });

  afterEach(() => {
    if (originalOllamaUrl === undefined) {
      delete process.env.OLLAMA_URL;
    } else {
      process.env.OLLAMA_URL = originalOllamaUrl;
    }

    if (originalEmbedProvider === undefined) {
      delete process.env.EMBED_PROVIDER;
    } else {
      process.env.EMBED_PROVIDER = originalEmbedProvider;
    }

    if (originalOpenAiApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalOpenAiApiKey;
    }

    if (originalOpenAiBaseUrl === undefined) {
      delete process.env.OPENAI_BASE_URL;
    } else {
      process.env.OPENAI_BASE_URL = originalOpenAiBaseUrl;
    }

    if (originalOpenAiEmbeddingModel === undefined) {
      delete process.env.OPENAI_EMBEDDING_MODEL;
    } else {
      process.env.OPENAI_EMBEDDING_MODEL = originalOpenAiEmbeddingModel;
    }

    globalThis.fetch = originalFetch;
  });

  it("returns embedding vectors for each input text", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ embedding: [0.1, 0.2, 0.3] }),
    });

    const result = await embed(["hello", "world"]);

    expect(result).toEqual([
      [0.1, 0.2, 0.3],
      [0.1, 0.2, 0.3],
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws on non-ok response from Ollama", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => "Service Unavailable",
    });

    await expect(embed(["hello"])).rejects.toThrow("Ollama embeddings failed: 503");
  });

  it("sends correct request body to Ollama API", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ embedding: [0.1] }),
    });

    await embed(["test input"]);

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/embeddings"),
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "nomic-embed-text", prompt: "test input" }),
      }),
    );
  });

  it("handles empty input array", async () => {
    const result = await embed([]);
    expect(result).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("processes texts in batches with concurrency limit", async () => {
    let currentConcurrent = 0;
    let maxConcurrent = 0;

    fetchMock.mockImplementation(async () => {
      currentConcurrent++;
      if (currentConcurrent > maxConcurrent) {
        maxConcurrent = currentConcurrent;
      }
      await new Promise((r) => setTimeout(r, 10));
      currentConcurrent--;
      return {
        ok: true,
        json: async () => ({ embedding: [0.1] }),
      };
    });

    const texts = Array.from({ length: 25 }, (_, i) => `text-${i}`);
    const result = await embed(texts);

    expect(result).toHaveLength(25);
    expect(maxConcurrent).toBeLessThanOrEqual(10);
    expect(maxConcurrent).toBeGreaterThan(1);
  });

  it("processes texts with custom concurrency", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ embedding: [0.1] }),
    });

    const texts = Array.from({ length: 5 }, (_, i) => `text-${i}`);
    const result = await embed(texts, 2);

    expect(result).toHaveLength(5);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("uses OpenAI embeddings when EMBED_PROVIDER=openai", async () => {
    process.env.EMBED_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "test-key";

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: [0.9, 0.8, 0.7] }] }),
    });

    const result = await embed(["hello"]);

    expect(result).toEqual([[0.9, 0.8, 0.7]]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.openai.com/v1/embeddings",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "content-type": "application/json",
          authorization: "Bearer test-key",
        }),
        body: JSON.stringify({ model: "text-embedding-3-small", input: "hello" }),
      }),
    );
  });

  it("throws when OPENAI_API_KEY is missing for EMBED_PROVIDER=openai", async () => {
    process.env.EMBED_PROVIDER = "openai";
    delete process.env.OPENAI_API_KEY;

    await expect(embed(["hello"])).rejects.toThrow("OPENAI_API_KEY is required");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
