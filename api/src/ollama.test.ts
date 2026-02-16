import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { embed } from "./ollama.js";

const originalFetch = globalThis.fetch;

describe("embed", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const originalOllamaUrl = process.env.OLLAMA_URL;

  beforeEach(() => {
    process.env.OLLAMA_URL = "http://localhost:11434";
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as any;
  });

  afterEach(() => {
    if (originalOllamaUrl === undefined) {
      delete process.env.OLLAMA_URL;
    } else {
      process.env.OLLAMA_URL = originalOllamaUrl;
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
});
