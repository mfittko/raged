import { describe, it, expect, beforeEach, vi } from "vitest";
import { cmdIngest } from "./ingest.js";
import * as utils from "../lib/utils.js";
import * as urlCheck from "../lib/url-check.js";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";

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

  it("should exit with error when --batchSize is invalid", async () => {
    const exitSpy = process.exit;
    let exitCode = 0;
    process.exit = ((code: number) => {
      exitCode = code;
      throw new Error("exit");
    }) as never;

    try {
      await cmdIngest({
        file: "/tmp/example.pdf",
        docType: "pdf",
        batchSize: "0",
      });
    } catch {
      // Expected to throw
    }

    expect(exitCode).toBe(2);
    process.exit = exitSpy;
  });

  it("should handle URL with no content ingested", async () => {
    const mockResponse = {
      upserted: 0,
      errors: [],
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

  it("should handle URL with partial success", async () => {
    const mockResponse = {
      upserted: 2,
      errors: [{ url: "https://example.com/page1", reason: "Failed" }],
    };

    globalThis.fetch = async () => {
      return new Response(JSON.stringify(mockResponse), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await cmdIngest({ url: "https://example.com" });

    globalThis.fetch = fetchMock;
  });

  it("should handle fetch errors for URL ingestion", async () => {
    const exitSpy = process.exit;
    let exitCode = 0;
    process.exit = ((code: number) => {
      exitCode = code;
      throw new Error("exit");
    }) as never;

    globalThis.fetch = async () => {
      throw new Error("Network error");
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

  it("should ingest URL with enrich disabled", async () => {
    const mockResponse = {
      upserted: 1,
      errors: [],
    };

    globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      expect(body.enrich).toBe(false);
      
      return new Response(JSON.stringify(mockResponse), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await cmdIngest({
      url: "https://example.com",
      enrich: false,
    });

    globalThis.fetch = fetchMock;
  });

  it("should include overwrite in payload when enabled", async () => {
    const mockResponse = {
      upserted: 1,
      errors: [],
    };

    globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      expect(body.overwrite).toBe(true);

      return new Response(JSON.stringify(mockResponse), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await cmdIngest({
      url: "https://example.com",
      overwrite: true,
    });

    globalThis.fetch = fetchMock;
  });

  it("should filter directory files by --doc-type before reading content", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "raged-ingest-test-"));
    const pdfPath = path.join(tempDir, "invoice.pdf");
    const txtPath = path.join(tempDir, "notes.txt");
    await fs.writeFile(pdfPath, "placeholder");
    await fs.writeFile(txtPath, "placeholder");

    const readSpy = vi.spyOn(utils, "readFileContent").mockResolvedValue({ text: "content" });

    globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      expect(body.items).toHaveLength(1);
      expect(body.items[0].source).toBe("invoice.pdf");
      expect(body.items[0].docType).toBe("pdf");
      expect(body.items[0].metadata.rootDir).toBe(tempDir.replace(/\\/g, "/"));
      expect(body.items[0].metadata.relativePath).toBe("invoice.pdf");
      expect(body.items[0].metadata.path).toBe("invoice.pdf");

      return new Response(JSON.stringify({ upserted: 1, errors: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await cmdIngest({ dir: tempDir, docType: "pdf" });

    expect(readSpy).toHaveBeenCalledTimes(1);
    expect(readSpy).toHaveBeenCalledWith(pdfPath, "pdf");

    readSpy.mockRestore();
    globalThis.fetch = fetchMock;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("should apply --maxFiles after --doc-type filtering during scan", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "raged-ingest-test-"));
    const txtA = path.join(tempDir, "a.txt");
    const txtB = path.join(tempDir, "b.txt");
    const pdfPath = path.join(tempDir, "c.pdf");
    await fs.writeFile(txtA, "placeholder");
    await fs.writeFile(txtB, "placeholder");
    await fs.writeFile(pdfPath, "placeholder");

    const readSpy = vi.spyOn(utils, "readFileContent").mockResolvedValue({ text: "content" });

    let fetchCalls = 0;
    globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      fetchCalls += 1;
      const body = JSON.parse(init?.body as string);
      expect(body.items).toHaveLength(1);
      expect(body.items[0].source).toBe("c.pdf");
      expect(body.items[0].docType).toBe("pdf");

      return new Response(JSON.stringify({ upserted: 1, errors: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await cmdIngest({ dir: tempDir, docType: "pdf", maxFiles: "1" });

    expect(fetchCalls).toBe(1);
    expect(readSpy).toHaveBeenCalledTimes(1);
    expect(readSpy).toHaveBeenCalledWith(pdfPath, "pdf");

    readSpy.mockRestore();
    globalThis.fetch = fetchMock;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("should split and continue when a batch request returns 413", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "raged-ingest-test-"));
    const firstPdf = path.join(tempDir, "a.pdf");
    const secondPdf = path.join(tempDir, "b.pdf");
    await fs.writeFile(firstPdf, "placeholder");
    await fs.writeFile(secondPdf, "placeholder");

    const readSpy = vi.spyOn(utils, "readFileContent").mockResolvedValue({ text: "content" });

    let callCount = 0;
    const seenSources: string[][] = [];
    globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      const sources = body.items.map((item: { source: string }) => item.source);
      seenSources.push(sources);
      callCount += 1;

      if (callCount === 1) {
        return new Response(JSON.stringify({ error: "Request body is too large" }), {
          status: 413,
          headers: { "content-type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ upserted: 1, errors: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await cmdIngest({ dir: tempDir, docType: "pdf" });

    expect(callCount).toBe(3);
    expect(seenSources[0]).toEqual(["a.pdf", "b.pdf"]);
    expect(seenSources[1]).toEqual(["a.pdf"]);
    expect(seenSources[2]).toEqual(["b.pdf"]);

    readSpy.mockRestore();
    globalThis.fetch = fetchMock;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("should respect --batchSize for directory ingestion", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "raged-ingest-test-"));
    const firstPdf = path.join(tempDir, "a.pdf");
    const secondPdf = path.join(tempDir, "b.pdf");
    const thirdPdf = path.join(tempDir, "c.pdf");
    await fs.writeFile(firstPdf, "placeholder");
    await fs.writeFile(secondPdf, "placeholder");
    await fs.writeFile(thirdPdf, "placeholder");

    const readSpy = vi.spyOn(utils, "readFileContent").mockResolvedValue({ text: "content" });

    const batchSizes: number[] = [];
    globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      batchSizes.push(body.items.length);

      return new Response(JSON.stringify({ upserted: body.items.length, errors: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await cmdIngest({ dir: tempDir, docType: "pdf", batchSize: "2" });

    expect(batchSizes).toEqual([2, 1]);

    readSpy.mockRestore();
    globalThis.fetch = fetchMock;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("should skip ignored paths from --ignore", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "raged-ingest-test-"));
    const keepPdf = path.join(tempDir, "keep.pdf");
    const ignoredDir = path.join(tempDir, "tmp");
    const ignoredPdf = path.join(ignoredDir, "skip.pdf");
    await fs.mkdir(ignoredDir, { recursive: true });
    await fs.writeFile(keepPdf, "placeholder");
    await fs.writeFile(ignoredPdf, "placeholder");

    const readSpy = vi.spyOn(utils, "readFileContent").mockResolvedValue({ text: "content" });

    globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      expect(body.items).toHaveLength(1);
      expect(body.items[0].source).toBe("keep.pdf");

      return new Response(JSON.stringify({ upserted: 1, errors: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await cmdIngest({ dir: tempDir, docType: "pdf", ignore: "tmp/**" });

    expect(readSpy).toHaveBeenCalledTimes(1);
    expect(readSpy).toHaveBeenCalledWith(keepPdf, "pdf");

    readSpy.mockRestore();
    globalThis.fetch = fetchMock;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("should load ignore patterns from --ignore-file", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "raged-ingest-test-"));
    const keepPdf = path.join(tempDir, "keep.pdf");
    const ignoredDir = path.join(tempDir, "tmp");
    const ignoredPdf = path.join(ignoredDir, "skip.pdf");
    const ignoreFile = path.join(tempDir, ".ingestignore");
    await fs.mkdir(ignoredDir, { recursive: true });
    await fs.writeFile(keepPdf, "placeholder");
    await fs.writeFile(ignoredPdf, "placeholder");
    await fs.writeFile(ignoreFile, "# comment\ntmp/**\n");

    const readSpy = vi.spyOn(utils, "readFileContent").mockResolvedValue({ text: "content" });

    globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      expect(body.items).toHaveLength(1);
      expect(body.items[0].source).toBe("keep.pdf");

      return new Response(JSON.stringify({ upserted: 1, errors: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await cmdIngest({ dir: tempDir, docType: "pdf", ignoreFile });

    expect(readSpy).toHaveBeenCalledTimes(1);
    expect(readSpy).toHaveBeenCalledWith(keepPdf, "pdf");

    readSpy.mockRestore();
    globalThis.fetch = fetchMock;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("should match root and nested files for **/*.tmp ignore pattern", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "raged-ingest-test-"));
    const keepPdf = path.join(tempDir, "keep.pdf");
    const rootTmp = path.join(tempDir, "root.tmp");
    const nestedDir = path.join(tempDir, "nested");
    const nestedTmp = path.join(nestedDir, "child.tmp");
    await fs.mkdir(nestedDir, { recursive: true });
    await fs.writeFile(keepPdf, "placeholder");
    await fs.writeFile(rootTmp, "placeholder");
    await fs.writeFile(nestedTmp, "placeholder");

    const readSpy = vi.spyOn(utils, "readFileContent").mockResolvedValue({ text: "content" });

    globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      expect(body.items).toHaveLength(1);
      expect(body.items[0].source).toBe("keep.pdf");

      return new Response(JSON.stringify({ upserted: 1, errors: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await cmdIngest({ dir: tempDir, docType: "pdf", ignore: "**/*.tmp" });

    expect(readSpy).toHaveBeenCalledTimes(1);
    expect(readSpy).toHaveBeenCalledWith(keepPdf, "pdf");

    readSpy.mockRestore();
    globalThis.fetch = fetchMock;
    await fs.rm(tempDir, { recursive: true, force: true });
  });
});

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

  it("should handle URL with no content ingested", async () => {
    const mockResponse = {
      upserted: 0,
      errors: [],
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

  it("should handle URL with partial success", async () => {
    const mockResponse = {
      upserted: 2,
      errors: [{ url: "https://example.com/page1", reason: "Failed" }],
    };

    globalThis.fetch = async () => {
      return new Response(JSON.stringify(mockResponse), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await cmdIngest({ url: "https://example.com" });

    globalThis.fetch = fetchMock;
  });

  it("should handle fetch errors for URL ingestion", async () => {
    const exitSpy = process.exit;
    let exitCode = 0;
    process.exit = ((code: number) => {
      exitCode = code;
      throw new Error("exit");
    }) as never;

    globalThis.fetch = async () => {
      throw new Error("Network error");
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

  it("should ingest URL with enrich disabled", async () => {
    const mockResponse = {
      upserted: 1,
      errors: [],
    };

    globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      expect(body.enrich).toBe(false);
      
      return new Response(JSON.stringify(mockResponse), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await cmdIngest({
      url: "https://example.com",
      enrich: false,
    });

    globalThis.fetch = fetchMock;
  });

  it("should include overwrite in payload when enabled", async () => {
    const mockResponse = {
      upserted: 1,
      errors: [],
    };

    globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      expect(body.overwrite).toBe(true);

      return new Response(JSON.stringify(mockResponse), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await cmdIngest({
      url: "https://example.com",
      overwrite: true,
    });

    globalThis.fetch = fetchMock;
  });
});

describe("ingest command urls-file and url-check", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    vi.restoreAllMocks();
  });

  it("should ingest URLs from --urls-file in batches and ignore comments/empty lines", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "raged-urls-file-"));
    const urlsFile = path.join(tempDir, "urls.txt");
    await fs.writeFile(
      urlsFile,
      [
        "# comment",
        "https://example.com/a",
        "",
        "https://example.com/b",
        "https://example.com/c",
      ].join("\n"),
    );

    const batchSizes: number[] = [];
    globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      batchSizes.push(body.items.length);
      return new Response(JSON.stringify({ upserted: body.items.length, errors: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await cmdIngest({ urlsFile, batchSize: "2" });
    expect(batchSizes).toEqual([2, 1]);

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("should exit when --urls-file contains no URLs", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "raged-urls-file-"));
    const urlsFile = path.join(tempDir, "empty-urls.txt");
    await fs.writeFile(urlsFile, "# only comments\n\n");

    const exitSpy = process.exit;
    let exitCode = 0;
    process.exit = ((code: number) => {
      exitCode = code;
      throw new Error("exit");
    }) as never;

    try {
      await cmdIngest({ urlsFile });
    } catch {
      // expected
    }

    expect(exitCode).toBe(2);
    process.exit = exitSpy;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("should exit when --urls-file contains invalid URLs", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "raged-urls-file-"));
    const urlsFile = path.join(tempDir, "invalid-urls.txt");
    await fs.writeFile(urlsFile, "https://example.com/ok\nnot-a-url\n");

    const exitSpy = process.exit;
    let exitCode = 0;
    process.exit = ((code: number) => {
      exitCode = code;
      throw new Error("exit");
    }) as never;

    try {
      await cmdIngest({ urlsFile });
    } catch {
      // expected
    }

    expect(exitCode).toBe(2);
    process.exit = exitSpy;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("should exit when --url-check is used without OPENAI_API_KEY", async () => {
    const originalKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;

    const exitSpy = process.exit;
    let exitCode = 0;
    process.exit = ((code: number) => {
      exitCode = code;
      throw new Error("exit");
    }) as never;

    try {
      await cmdIngest({ url: "https://example.com/a", urlCheck: true });
    } catch {
      // expected
    }

    expect(exitCode).toBe(2);
    process.exit = exitSpy;
    process.env.OPENAI_API_KEY = originalKey;
  });

  it("should filter URLs with --url-check and ingest only passed entries", async () => {
    const originalKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "test-key";

    vi.spyOn(urlCheck, "checkUrls").mockResolvedValue([
      { url: "https://example.com/pass", reachable: true, meaningful: true, reason: "good" },
      { url: "https://example.com/skip", reachable: true, meaningful: false, reason: "thin" },
    ]);

    const ingested: string[] = [];
    globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      ingested.push(...body.items.map((item: { url: string }) => item.url));
      return new Response(JSON.stringify({ upserted: body.items.length, errors: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await cmdIngest({ url: "https://example.com/pass", urlCheck: true });
    expect(ingested).toEqual(["https://example.com/pass"]);

    process.env.OPENAI_API_KEY = originalKey;
  });

  it("should stop ingestion when all URLs are skipped by --url-check", async () => {
    const originalKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "test-key";

    vi.spyOn(urlCheck, "checkUrls").mockResolvedValue([
      { url: "https://example.com/skip", reachable: true, meaningful: false, reason: "thin" },
    ]);

    const fetchSpy = vi.fn<typeof globalThis.fetch>();
    globalThis.fetch = fetchSpy;

    await cmdIngest({ url: "https://example.com/skip", urlCheck: true });
    expect(fetchSpy).not.toHaveBeenCalled();

    process.env.OPENAI_API_KEY = originalKey;
  });
});
