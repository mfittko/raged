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
        expect(url).toBe("http://localhost:8080/enrichment/stats?collection=docs");
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
        expect(body.filter).toBeUndefined();
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

  it("should only show stats when stats is true", async () => {
    const mockStats = {
      queue: { pending: 5, processing: 2, deadLetter: 0 },
      totals: { enriched: 100, failed: 2, pending: 5, processing: 2, none: 10 },
    };

    globalThis.fetch = async (url: string | URL | Request) => {
      expect(url).toBe("http://localhost:8080/enrichment/stats?collection=docs");
      return new Response(JSON.stringify(mockStats), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await cmdEnrich({
      stats: true,
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
        expect(url).toBe("http://localhost:8080/enrichment/stats?collection=docs");
        return new Response(JSON.stringify(mockStats), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      } else {
        const body = JSON.parse(init?.body as string);
        expect(body.force).toBe(true);
        expect(body.filter).toBeUndefined();
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

  it("should pass filter to enqueue", async () => {
    const mockStats = {
      queue: { pending: 5, processing: 2, deadLetter: 0 },
      totals: { enriched: 100, failed: 2, pending: 5, processing: 2, none: 10 },
    };
    const mockEnqueueResult = { enqueued: 12 };

    let callCount = 0;
    globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      callCount++;

      if (callCount === 1) {
        expect(_url).toBe("http://localhost:8080/enrichment/stats?collection=docs&filter=invoice");
        return new Response(JSON.stringify(mockStats), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      const body = JSON.parse(init?.body as string);
      expect(body.force).toBe(false);
      expect(body.filter).toBe("invoice");
      return new Response(JSON.stringify(mockEnqueueResult), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await cmdEnrich({
      filter: "invoice",
    });

    globalThis.fetch = fetchMock;
  });

  it("should clear queue when clear is true", async () => {
    const mockStats = {
      queue: { pending: 5, processing: 2, deadLetter: 0 },
      totals: { enriched: 100, failed: 2, pending: 5, processing: 2, none: 10 },
    };
    const mockClearResult = { cleared: 5 };

    let callCount = 0;
    globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
      callCount++;

      if (callCount === 1) {
        expect(url).toBe("http://localhost:8080/enrichment/stats?collection=docs");
        return new Response(JSON.stringify(mockStats), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      expect(url).toBe("http://localhost:8080/enrichment/clear");
      const body = JSON.parse(init?.body as string);
      expect(body.collection).toBe("docs");
      expect(body.filter).toBeUndefined();
      return new Response(JSON.stringify(mockClearResult), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await cmdEnrich({ clear: true });

    expect(callCount).toBe(2);
    globalThis.fetch = fetchMock;
  });

  it("should clear queue with filter when clear and filter are combined", async () => {
    const mockStats = {
      queue: { pending: 5, processing: 2, deadLetter: 0 },
      totals: { enriched: 100, failed: 2, pending: 5, processing: 2, none: 10 },
    };
    const mockClearResult = { cleared: 2 };

    let callCount = 0;
    globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
      callCount++;

      if (callCount === 1) {
        expect(url).toBe("http://localhost:8080/enrichment/stats?collection=docs&filter=invoice");
        return new Response(JSON.stringify(mockStats), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      expect(url).toBe("http://localhost:8080/enrichment/clear");
      const body = JSON.parse(init?.body as string);
      expect(body.collection).toBe("docs");
      expect(body.filter).toBe("invoice");
      return new Response(JSON.stringify(mockClearResult), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await cmdEnrich({ clear: true, filter: "invoice" });

    expect(callCount).toBe(2);
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
