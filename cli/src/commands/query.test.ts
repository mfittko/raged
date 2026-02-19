import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs/promises";
import path from "node:path";
import { cmdQuery } from "./query.js";

describe("query command", () => {
  let fetchMock: typeof globalThis.fetch;
  
  beforeEach(() => {
    fetchMock = globalThis.fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = fetchMock;
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
      expect(body.minScore).toBe(0.4);
      
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

  });

  it("should handle query with filters", async () => {
    const mockResults = { results: [] };

    globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      expect(body.filter).toBeDefined();
      expect(body.filter.repoId).toBe("my-repo");
      expect(body.filter.path).toBe("src/");
      expect(body.filter.lang).toBe("ts");
      
      return new Response(JSON.stringify(mockResults), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await cmdQuery({
      q: "test",
      repoId: "my-repo",
      pathPrefix: "src/",
      lang: "ts",
    });

  });

  it("should pass custom minScore", async () => {
    const mockResults = { results: [] };

    globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      expect(body.minScore).toBe(0.8);

      return new Response(JSON.stringify(mockResults), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await cmdQuery({ q: "test", minScore: "0.8" });

  });

  it("should query multiple collections when --collections is provided", async () => {
    const calls: string[] = [];

    globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      calls.push(body.collection);

      return new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await cmdQuery({ q: "invoice", collections: "docs,downloads-pdf" });
    expect(calls).toEqual(["docs", "downloads-pdf"]);
  });

  it("should deduplicate merged results by payload checksum when --unique is set", async () => {
    globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);

      if (body.collection === "docs") {
        return new Response(JSON.stringify({
          results: [
            { text: "doc copy", score: 0.91, source: "docs/a.pdf", payload: { payloadChecksum: "same-checksum" } },
          ],
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      return new Response(JSON.stringify({
        results: [
          { text: "pdf copy", score: 0.89, source: "downloads/a.pdf", payload: { payloadChecksum: "same-checksum" } },
          { text: "unique", score: 0.88, source: "downloads/b.pdf", payload: { payloadChecksum: "unique-checksum" } },
        ],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const infoSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await cmdQuery({ q: "invoice", collections: "docs,downloads-pdf", unique: true, topK: "10" });

    const output = infoSpy.mock.calls.map((args) => String(args[0] ?? ""));
    const sourceLines = output.filter((line) => line.startsWith("source:"));
    expect(sourceLines).toContain("source: docs/a.pdf");
    expect(sourceLines).toContain("source: downloads/b.pdf");
    expect(sourceLines).not.toContain("source: downloads/a.pdf");
    expect(output).toContain("Deduplicated 1 result(s) by payload checksum.");
  });

  it("should keep duplicates when --unique is not set", async () => {
    globalThis.fetch = async () => {
      return new Response(JSON.stringify({
        results: [
          { text: "copy1", score: 0.9, source: "one.pdf", payload: { payloadChecksum: "same-checksum" } },
          { text: "copy2", score: 0.89, source: "two.pdf", payload: { payloadChecksum: "same-checksum" } },
        ],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const infoSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await cmdQuery({ q: "invoice", topK: "10" });

    const output = infoSpy.mock.calls.map((args) => String(args[0] ?? ""));
    const sourceLines = output.filter((line) => line.startsWith("source:"));
    expect(sourceLines).toContain("source: one.pdf");
    expect(sourceLines).toContain("source: two.pdf");
    expect(output).not.toContain("Deduplicated 1 result(s) by payload checksum.");
  });

  it("should use auto minScore 0.3 for single-term query", async () => {
    const mockResults = { results: [] };

    globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      expect(body.minScore).toBe(0.3);

      return new Response(JSON.stringify(mockResults), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await cmdQuery({ q: "INV89909018" });
  });

  it("should use auto minScore 0.6 for five-term query", async () => {
    const mockResults = { results: [] };

    globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      expect(body.minScore).toBe(0.6);

      return new Response(JSON.stringify(mockResults), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await cmdQuery({ q: "Github invoice INV89909018 copilot pro" });
  });

  it("should accept positional query text", async () => {
    const mockResults = { results: [] };

    globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      expect(body.query).toBe("invoice INV89909018");

      return new Response(JSON.stringify(mockResults), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await cmdQuery({ positionalQuery: "invoice INV89909018" });
  });

  it("should prefer --q over positional query text", async () => {
    const mockResults = { results: [] };

    globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      expect(body.query).toBe("from-flag");

      return new Response(JSON.stringify(mockResults), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await cmdQuery({ q: "from-flag", positionalQuery: "from-positional" });
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

  });

  it("should download first match text when --full is used", async () => {
    const mockResults = {
      results: [
        { text: "full text content", score: 0.95, source: "invoice-123.pdf" },
      ],
    };

    globalThis.fetch = async (url: string | URL | Request) => {
      const value = String(url);
      if (value.endsWith("/query")) {
        return new Response(JSON.stringify(mockResults), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (value.endsWith("/query/fulltext-first")) {
        return new Response("full document text", {
          status: 200,
          headers: {
            "content-type": "text/plain; charset=utf-8",
            "content-disposition": 'attachment; filename="invoice-123.txt"',
            "x-raged-source": "invoice-123.pdf",
          },
        });
      }

      return new Response("not found", { status: 404 });
    };

    const originalHome = process.env.HOME;
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "raged-cli-test-"));
    await fs.mkdir(path.join(tempHome, "Downloads"), { recursive: true });
    process.env.HOME = tempHome;

    await cmdQuery({
      q: "packt invoice",
      full: true,
    });

    const downloadedPath = path.join(tempHome, "Downloads", "invoice-123.txt");
    const downloadedText = await fs.readFile(downloadedPath, "utf8");
    expect(downloadedText).toBe("full document text");

    process.env.HOME = originalHome;
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  it("should use tmp file for --open on non-URL sources", async () => {
    const queryResults = {
      results: [
        { text: "content", score: 0.95, source: "INV89909018.pdf" },
      ],
    };

    const downloadData = Buffer.from("pdf-bytes");

    globalThis.fetch = async (url: string | URL | Request) => {
      const value = String(url);
      if (value.endsWith("/query")) {
        return new Response(JSON.stringify(queryResults), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (value.endsWith("/query/download-first")) {
        return new Response(downloadData, {
          status: 200,
          headers: {
            "content-type": "application/pdf",
            "content-disposition": 'attachment; filename="INV89909018.pdf"',
            "x-raged-source": "INV89909018.pdf",
          },
        });
      }

      return new Response("not found", { status: 404 });
    };

    const originalHome = process.env.HOME;
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "raged-cli-test-"));
    await fs.mkdir(path.join(tempHome, "Downloads"), { recursive: true });
    process.env.HOME = tempHome;

    await cmdQuery(
      {
        q: "INV89909018",
        open: true,
      },
      {
        openTargetFn: () => {},
      }
    );

    const downloads = await fs.readdir(path.join(tempHome, "Downloads"));
    expect(downloads).toEqual([]);

    const openTempPath = path.join(os.tmpdir(), "raged-open", "INV89909018.pdf");
    const written = await fs.readFile(openTempPath);
    expect(Buffer.compare(written, downloadData)).toBe(0);

    process.env.HOME = originalHome;
    await fs.rm(tempHome, { recursive: true, force: true });
    await fs.rm(path.join(os.tmpdir(), "raged-open"), { recursive: true, force: true });
  });

  it("should print full text to stdout when --full --stdout is used", async () => {
    const mockResults = {
      results: [
        { text: "chunk text", score: 0.95, source: "invoice-123.pdf" },
      ],
    };

    globalThis.fetch = async (url: string | URL | Request) => {
      const value = String(url);
      if (value.endsWith("/query")) {
        return new Response(JSON.stringify(mockResults), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (value.endsWith("/query/fulltext-first")) {
        return new Response("full document text", {
          status: 200,
          headers: {
            "content-type": "text/plain; charset=utf-8",
            "content-disposition": 'attachment; filename="invoice-123.txt"',
            "x-raged-source": "invoice-123.pdf",
          },
        });
      }

      return new Response("not found", { status: 404 });
    };

    const originalHome = process.env.HOME;
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "raged-cli-test-"));
    await fs.mkdir(path.join(tempHome, "Downloads"), { recursive: true });
    process.env.HOME = tempHome;

    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await cmdQuery({
      q: "packt invoice",
      full: true,
      stdout: true,
    });

    expect(writeSpy).toHaveBeenCalled();
    const written = writeSpy.mock.calls.map((call) => String(call[0] ?? "")).join("");
    expect(written).toContain("full document text");

    const downloads = await fs.readdir(path.join(tempHome, "Downloads"));
    expect(downloads).toEqual([]);

    process.env.HOME = originalHome;
    writeSpy.mockRestore();
    await fs.rm(tempHome, { recursive: true, force: true });
  });
});
