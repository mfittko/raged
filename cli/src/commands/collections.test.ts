import { describe, it, expect, beforeEach } from "vitest";
import { cmdCollections } from "./collections.js";

describe("collections command", () => {
  let fetchMock: typeof globalThis.fetch;

  beforeEach(() => {
    fetchMock = globalThis.fetch;
  });

  it("fetches collection stats", async () => {
    globalThis.fetch = async (url: string | URL | Request) => {
      expect(url).toBe("http://localhost:8080/collections");
      return new Response(
        JSON.stringify({
          collections: [
            {
              collection: "downloads-pdf",
              documentCount: 10,
              chunkCount: 100,
              enrichedChunkCount: 90,
              lastSeenAt: "2026-02-17T00:00:00.000Z",
            },
          ],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        }
      );
    };

    await cmdCollections({ api: "http://localhost:8080" });
    globalThis.fetch = fetchMock;
  });

  it("throws on API failure", async () => {
    globalThis.fetch = async () => new Response("server error", { status: 500 });

    await expect(cmdCollections({ api: "http://localhost:8080" })).rejects.toThrow("Failed to list collections: 500");
    globalThis.fetch = fetchMock;
  });
});
