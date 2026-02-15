import { describe, it, expect, beforeEach } from "vitest";
import { cmdIngest } from "./ingest.js";

describe("ingest command", () => {
  let fetchMock: typeof globalThis.fetch;
  
  beforeEach(() => {
    fetchMock = globalThis.fetch;
  });

  it("should ingest a URL with correct parameters", async () => {
    const mockResponse = {
      upserted: 5,
      errors: [],
    };

    globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
      expect(url).toBe("http://localhost:8080/ingest");
      expect(init?.method).toBe("POST");
      
      const body = JSON.parse(init?.body as string);
      expect(body.collection).toBe("docs");
      expect(body.items).toHaveLength(1);
      expect(body.items[0].url).toBe("https://example.com");
      expect(body.enrich).toBe(true);
      
      return new Response(JSON.stringify(mockResponse), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await cmdIngest({
      url: "https://example.com",
      api: "http://localhost:8080",
      collection: "docs",
    });

    globalThis.fetch = fetchMock;
  });

  it("should ingest URL with docType override", async () => {
    const mockResponse = { upserted: 1, errors: [] };

    globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      expect(body.items[0].docType).toBe("pdf");
      
      return new Response(JSON.stringify(mockResponse), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await cmdIngest({
      url: "https://example.com/doc",
      docType: "pdf",
    });

    globalThis.fetch = fetchMock;
  });

  it("should exit with error when no input is provided", async () => {
    const exitSpy = process.exit;
    let exitCode = 0;
    process.exit = ((code: number) => {
      exitCode = code;
      throw new Error("exit");
    }) as never;

    try {
      await cmdIngest({});
    } catch (e) {
      // Expected to throw
    }

    expect(exitCode).toBe(2);
    process.exit = exitSpy;
  });

  it("should exit with error when multiple inputs are provided", async () => {
    const exitSpy = process.exit;
    let exitCode = 0;
    process.exit = ((code: number) => {
      exitCode = code;
      throw new Error("exit");
    }) as never;

    try {
      await cmdIngest({
        file: "/path/to/file.txt",
        url: "https://example.com",
      });
    } catch (e) {
      // Expected to throw
    }

    expect(exitCode).toBe(2);
    process.exit = exitSpy;
  });

  it("should handle ingestion errors", async () => {
    const mockResponse = {
      upserted: 0,
      errors: [{ url: "https://example.com", reason: "Not found" }],
    };

    const exitSpy = process.exit;
    let exitCode = 0;
    process.exit = ((code: number) => {
      exitCode = code;
      throw new Error("exit");
    }) as never;

    globalThis.fetch = async () => {
      return new Response(JSON.stringify(mockResponse), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    try {
      await cmdIngest({ url: "https://example.com" });
    } catch (e) {
      // Expected to throw
    }

    expect(exitCode).toBe(1);
    process.exit = exitSpy;
    globalThis.fetch = fetchMock;
  });
});
