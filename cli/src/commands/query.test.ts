import { describe, it, expect, beforeEach } from "vitest";
import { cmdQuery } from "./query.js";

describe("query command", () => {
  let fetchMock: typeof globalThis.fetch;
  
  beforeEach(() => {
    fetchMock = globalThis.fetch;
  });

  it("should query the API with correct parameters", async () => {
    const mockResults = {
      results: [
        { text: "sample text", score: 0.95, source: "test.md" },
      ],
    };

    globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
      expect(url).toBe("http://localhost:8080/query");
      expect(init?.method).toBe("POST");
      
      const body = JSON.parse(init?.body as string);
      expect(body.collection).toBe("docs");
      expect(body.query).toBe("test query");
      expect(body.topK).toBe(8);
      
      return new Response(JSON.stringify(mockResults), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await cmdQuery({
      q: "test query",
      api: "http://localhost:8080",
      collection: "docs",
    });

    globalThis.fetch = fetchMock;
  });

  it("should handle query with filters", async () => {
    const mockResults = { results: [] };

    globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      expect(body.filter).toBeDefined();
      expect(body.filter.must).toHaveLength(2);
      expect(body.filter.must[0].key).toBe("repoId");
      expect(body.filter.must[1].key).toBe("lang");
      
      return new Response(JSON.stringify(mockResults), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await cmdQuery({
      q: "test",
      repoId: "my-repo",
      lang: "ts",
    });

    globalThis.fetch = fetchMock;
  });

  it("should exit with error when query is missing", async () => {
    const exitSpy = process.exit;
    let exitCode = 0;
    process.exit = ((code: number) => {
      exitCode = code;
      throw new Error("exit");
    }) as never;

    try {
      await cmdQuery({});
    } catch (e) {
      // Expected to throw
    }

    expect(exitCode).toBe(2);
    process.exit = exitSpy;
  });

  it("should handle API errors", async () => {
    globalThis.fetch = async () => {
      return new Response("Internal Server Error", { status: 500 });
    };

    await expect(cmdQuery({ q: "test" })).rejects.toThrow("Query failed: 500");

    globalThis.fetch = fetchMock;
  });
});
