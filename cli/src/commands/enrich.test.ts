import { describe, it, expect, beforeEach } from "vitest";
import { cmdEnrich } from "./enrich.js";

describe("enrich command", () => {
  let fetchMock: typeof globalThis.fetch;
  
  beforeEach(() => {
    fetchMock = globalThis.fetch;
  });

  it("should get stats and enqueue enrichment tasks", async () => {
    const mockStats = {
      queue: { pending: 5, processing: 2, deadLetter: 0 },
      totals: { enriched: 100, failed: 2, pending: 5, processing: 2, none: 10 },
    };
    const mockEnqueueResult = { enqueued: 5 };

    let callCount = 0;
    globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
      callCount++;
      
      if (callCount === 1) {
        expect(url).toBe("http://localhost:8080/enrichment/stats");
        expect(init?.method).toBe("GET");
        return new Response(JSON.stringify(mockStats), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      } else {
        expect(url).toBe("http://localhost:8080/enrichment/enqueue");
        expect(init?.method).toBe("POST");
        const body = JSON.parse(init?.body as string);
        expect(body.collection).toBe("docs");
        expect(body.force).toBe(false);
        return new Response(JSON.stringify(mockEnqueueResult), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
    };

    await cmdEnrich({
      api: "http://localhost:8080",
      collection: "docs",
    });

    expect(callCount).toBe(2);
    globalThis.fetch = fetchMock;
  });

  it("should only show stats when statsOnly is true", async () => {
    const mockStats = {
      queue: { pending: 5, processing: 2, deadLetter: 0 },
      totals: { enriched: 100, failed: 2, pending: 5, processing: 2, none: 10 },
    };

    globalThis.fetch = async (url: string | URL | Request) => {
      expect(url).toBe("http://localhost:8080/enrichment/stats");
      return new Response(JSON.stringify(mockStats), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await cmdEnrich({
      statsOnly: true,
    });

    globalThis.fetch = fetchMock;
  });

  it("should pass force flag to enqueue", async () => {
    const mockStats = {
      queue: { pending: 5, processing: 2, deadLetter: 0 },
      totals: { enriched: 100, failed: 2, pending: 5, processing: 2, none: 10 },
    };
    const mockEnqueueResult = { enqueued: 115 };

    let callCount = 0;
    globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
      callCount++;
      
      if (callCount === 1) {
        return new Response(JSON.stringify(mockStats), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      } else {
        const body = JSON.parse(init?.body as string);
        expect(body.force).toBe(true);
        return new Response(JSON.stringify(mockEnqueueResult), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
    };

    await cmdEnrich({
      force: true,
    });

    globalThis.fetch = fetchMock;
  });

  it("should handle API errors", async () => {
    globalThis.fetch = async () => {
      return new Response("Internal Server Error", { status: 500 });
    };

    await expect(cmdEnrich({})).rejects.toThrow("Failed to get stats: 500");

    globalThis.fetch = fetchMock;
  });
});
