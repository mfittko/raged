import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ingest } from "./ingest.js";
import type { IngestDeps, IngestRequest } from "./ingest.js";
import { query as dbQuery } from "../db.js";

// Mock the db module to avoid Postgres connection in tests
vi.mock("../db.js", () => ({
  query: vi.fn(async () => ({ rows: [] })),
  getPool: vi.fn(),
  runMigrations: vi.fn(),
  closePool: vi.fn(),
}));

// Mock url-fetch and url-extract modules
vi.mock("./url-fetch.js", () => {
  const mockFetchUrls = vi.fn();
  return {
    fetchUrls: mockFetchUrls,
    __mockFetchUrls: mockFetchUrls,
  };
});

vi.mock("./url-extract.js", () => {
  const mockExtractContentAsync = vi.fn();
  return {
    extractContentAsync: mockExtractContentAsync,
    __mockExtractContentAsync: mockExtractContentAsync,
  };
});

function makeDeps(overrides?: Partial<IngestDeps>): IngestDeps {
  return {
    embed: overrides?.embed ?? vi.fn(async (texts: string[]) =>
      texts.map(() => [0.1, 0.2, 0.3])
    ),
    ensureCollection: overrides?.ensureCollection ?? vi.fn(async () => {}),
    upsert: overrides?.upsert ?? vi.fn(async () => {}),
    collectionName: overrides?.collectionName ?? vi.fn((name?: string) => name || "docs"),
  };
}

describe("ingest service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("ensures the collection exists before upserting", async () => {
    const deps = makeDeps();
    const request: IngestRequest = {
      collection: "test-col",
      items: [{ text: "hello", source: "test.txt" }],
    };

    await ingest(request, deps);

    expect(deps.ensureCollection).toHaveBeenCalledWith("test-col");
  });

  it("uses default collection when none specified", async () => {
    const deps = makeDeps();
    const request: IngestRequest = {
      items: [{ text: "hello", source: "test.txt" }],
    };

    await ingest(request, deps);

    expect(deps.collectionName).toHaveBeenCalledWith(undefined);
  });

  it("chunks text and embeds each chunk", async () => {
    const embedMock = vi.fn(async (texts: string[]) =>
      texts.map(() => [0.1, 0.2, 0.3])
    );
    const deps = makeDeps({ embed: embedMock });
    const request: IngestRequest = {
      items: [{ text: "hello world", source: "test.txt" }],
    };

    await ingest(request, deps);

    // "hello world" is short, so it should be a single chunk
    expect(embedMock).toHaveBeenCalledWith(["hello world"]);
  });

  it("upserts points with correct structure", async () => {
    const upsertMock = vi.fn(async () => {});
    const deps = makeDeps({ upsert: upsertMock });
    const request: IngestRequest = {
      collection: "my-col",
      items: [
        {
          id: "doc-1",
          text: "hello world",
          source: "test.txt",
          metadata: { lang: "en" },
        },
      ],
    };

    await ingest(request, deps);

    const points = (upsertMock.mock.calls[0] as any)[1];
    expect(points).toBeDefined();
    expect(points[0].id).toBe("doc-1:0");
    expect(points[0].vector).toEqual([0.1, 0.2, 0.3]);
    // Check core fields are present
    expect(points[0].payload.text).toBe("hello world");
    expect(points[0].payload.source).toBe("test.txt");
    expect(points[0].payload.chunkIndex).toBe(0);
    expect(points[0].payload.lang).toBe("en");
    // Check new enrichment fields are present
    expect(points[0].payload.docType).toBeDefined();
    expect(points[0].payload.enrichmentStatus).toBeDefined();
    expect(points[0].payload.ingestedAt).toBeDefined();
    expect(points[0].payload.tier1Meta).toBeDefined();
  });

  it("generates UUID when item has no id", async () => {
    const upsertMock = vi.fn(async () => {});
    const deps = makeDeps({ upsert: upsertMock });
    const request: IngestRequest = {
      items: [{ text: "hello", source: "test.txt" }],
    };

    await ingest(request, deps);

    const points = (upsertMock.mock.calls[0] as any)[1];
    // Should have a UUID-like format: <uuid>:0
    expect(points).toBeDefined();
    expect(points[0].id).toMatch(/^.+:0$/);
    expect(points[0].id.length).toBeGreaterThan(3);
  });

  it("returns the count of upserted points", async () => {
    const deps = makeDeps();
    const request: IngestRequest = {
      items: [
        { text: "item one", source: "a.txt" },
        { text: "item two", source: "b.txt" },
      ],
    };

    const result = await ingest(request, deps);

    expect(result).toEqual({ ok: true, upserted: 2 });
  });

  it("handles multiple items with multiple chunks each", async () => {
    const embedMock = vi.fn(async (texts: string[]) =>
      texts.map(() => [0.1, 0.2, 0.3])
    );
    const upsertMock = vi.fn(async () => {});
    const deps = makeDeps({ embed: embedMock, upsert: upsertMock });

    // Create text long enough to produce 2 chunks
    const longText = Array.from({ length: 30 }, (_, i) =>
      `Line ${i}: ${"x".repeat(80)}`
    ).join("\n");

    const request: IngestRequest = {
      items: [
        { id: "doc-a", text: longText, source: "a.txt" },
        { id: "doc-b", text: "short", source: "b.txt" },
      ],
    };

    const result = await ingest(request, deps);

    // doc-a should produce multiple chunks, doc-b should produce 1
    expect(result.upserted).toBeGreaterThan(2);

    const points = (upsertMock.mock.calls[0] as any)[1];
    expect(points).toBeDefined();
    // Verify chunk indices are sequential per document
    const docAPoints = points.filter((p: { id: string }) => p.id.startsWith("doc-a:"));
    for (let i = 0; i < docAPoints.length; i++) {
      expect(docAPoints[i].id).toBe(`doc-a:${i}`);
    }
  });

  it("spreads item metadata into point payload", async () => {
    const upsertMock = vi.fn(async () => {});
    const deps = makeDeps({ upsert: upsertMock });
    const request: IngestRequest = {
      items: [
        {
          id: "doc-1",
          text: "hello",
          source: "test.txt",
          metadata: { repoId: "my-repo", path: "src/test.txt", lang: "ts", bytes: 100 },
        },
      ],
    };

    await ingest(request, deps);

    const points = (upsertMock.mock.calls[0] as any)[1];
    expect(points).toBeDefined();
    // Check metadata is spread into payload
    expect(points[0].payload.repoId).toBe("my-repo");
    expect(points[0].payload.path).toBe("src/test.txt");
    expect(points[0].payload.lang).toBe("ts");
    expect(points[0].payload.bytes).toBe(100);
    expect(points[0].payload.text).toBe("hello");
    expect(points[0].payload.source).toBe("test.txt");
    expect(points[0].payload.chunkIndex).toBe(0);
    // New enrichment fields should also be present
    expect(points[0].payload.docType).toBeDefined();
    expect(points[0].payload.enrichmentStatus).toBeDefined();
    expect(points[0].payload.ingestedAt).toBeDefined();
    expect(points[0].payload.tier1Meta).toBeDefined();
  });

  it("enqueues enrichment tasks when enrichment is enabled", async () => {
    // Mock environment variable
    const originalEnv = process.env.ENRICHMENT_ENABLED;
    process.env.ENRICHMENT_ENABLED = "true";

    const upsertMock = vi.fn(async () => {});
    const deps = makeDeps({ upsert: upsertMock });
    const request: IngestRequest = {
      items: [
        { id: "doc-1", text: "hello world", source: "test.ts", docType: "code" },
        { id: "doc-2", text: "short", source: "note.txt", docType: "text" },
      ],
    };

    const result = await ingest(request, deps);

    // Verify enrichment response structure
    expect(result.enrichment).toBeDefined();
    expect(result.enrichment?.enqueued).toBe(2);
    expect(result.enrichment?.docTypes).toEqual({ code: 1, text: 1 });

    // Verify enrichmentStatus in payload - collect all points from all upsert calls
    const allPoints = upsertMock.mock.calls.flatMap((call: any) => call[1]);
    expect(allPoints.length).toBe(2);
    expect(allPoints[0].payload.enrichmentStatus).toBe("pending");
    expect(allPoints[1].payload.enrichmentStatus).toBe("pending");

    const queryMock = vi.mocked(dbQuery);
    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain("INSERT INTO task_queue");
    expect(params).toHaveLength(8);

    // Restore environment
    process.env.ENRICHMENT_ENABLED = originalEnv;
  });

  it("skips enrichment when disabled", async () => {
    // Ensure enrichment is disabled
    const originalEnv = process.env.ENRICHMENT_ENABLED;
    process.env.ENRICHMENT_ENABLED = "false";

    const deps = makeDeps();
    const request: IngestRequest = {
      items: [{ text: "hello", source: "test.txt" }],
    };

    const result = await ingest(request, deps);

    // No enrichment response when disabled
    expect(result.enrichment).toBeUndefined();

    // Restore environment
    process.env.ENRICHMENT_ENABLED = originalEnv;
  });

  it("fetches and ingests URL items without text", async () => {
    const urlFetch = await import("./url-fetch.js");
    const urlExtract = await import("./url-extract.js");
    const mockFetchUrls = (urlFetch as any).__mockFetchUrls;
    const mockExtractContentAsync = (urlExtract as any).__mockExtractContentAsync;

    // Setup mock responses
    mockFetchUrls.mockResolvedValue({
      results: new Map([
        [
          "https://example.com/article",
          {
            url: "https://example.com/article",
            resolvedUrl: "https://example.com/article",
            contentType: "text/html",
            status: 200,
            body: Buffer.from("<html><body>Article content</body></html>"),
            fetchedAt: "2024-01-01T00:00:00Z",
          },
        ],
      ]),
      errors: [],
    });

    mockExtractContentAsync.mockResolvedValue({
      text: "Article content",
      title: "Example Article",
      strategy: "readability",
      contentType: "text/html",
    });

    const upsertMock = vi.fn(async () => {});
    const deps = makeDeps({ upsert: upsertMock });
    const request: IngestRequest = {
      items: [{ url: "https://example.com/article" }],
    };

    const result = await ingest(request, deps);

    // Verify fetch was called
    expect(mockFetchUrls).toHaveBeenCalledWith(["https://example.com/article"]);
    expect(mockExtractContentAsync).toHaveBeenCalled();

    // Verify result includes fetched count
    expect(result.fetched).toBe(1);
    expect(result.upserted).toBe(1);

    // Verify upserted point has fetch metadata
    const points = (upsertMock.mock.calls[0] as any)[1];
    expect(points).toBeDefined();
    expect(points[0].payload.text).toBe("Article content");
    expect(points[0].payload.fetchedUrl).toBe("https://example.com/article");
    expect(points[0].payload.resolvedUrl).toBe("https://example.com/article");
    expect(points[0].payload.contentType).toBe("text/html");
    expect(points[0].payload.fetchStatus).toBe(200);
    expect(points[0].payload.extractionStrategy).toBe("readability");
    expect(points[0].payload.extractedTitle).toBe("Example Article");

    // Cleanup
    mockFetchUrls.mockClear();
    mockExtractContentAsync.mockClear();
  });

  it("uses provided text for URL items with both url and text", async () => {
    const urlFetch = await import("./url-fetch.js");
    const mockFetchUrls = (urlFetch as any).__mockFetchUrls;

    const upsertMock = vi.fn(async () => {});
    const deps = makeDeps({ upsert: upsertMock });
    const request: IngestRequest = {
      items: [
        {
          url: "https://example.com/doc",
          text: "Pre-provided text",
          source: "my-source",
        },
      ],
    };

    const result = await ingest(request, deps);

    // Fetch should not be called when text is already provided
    expect(mockFetchUrls).not.toHaveBeenCalled();

    // Verify text was used as-is
    const points = (upsertMock.mock.calls[0] as any)[1];
    expect(points).toBeDefined();
    expect(points[0].payload.text).toBe("Pre-provided text");
    expect(points[0].payload.source).toBe("my-source");
    expect(points[0].payload.itemUrl).toBe("https://example.com/doc");

    // No fetch metadata should be present
    expect(points[0].payload.fetchedUrl).toBeUndefined();
  });

  it("auto-sets source from URL when text is provided but source is omitted", async () => {
    const urlFetch = await import("./url-fetch.js");
    const mockFetchUrls = (urlFetch as any).__mockFetchUrls;

    const upsertMock = vi.fn(async () => {});
    const deps = makeDeps({ upsert: upsertMock });
    const request: IngestRequest = {
      items: [
        {
          url: "https://example.com/doc-without-source?q=1",
          text: "Provided text without explicit source",
        },
      ],
    };

    await ingest(request, deps);

    expect(mockFetchUrls).not.toHaveBeenCalled();

    const points = (upsertMock.mock.calls[0] as any)[1];
    expect(points).toBeDefined();
    expect(points[0].payload.text).toBe("Provided text without explicit source");
    expect(points[0].payload.source).toBe("https://example.com/doc-without-source");
    expect(points[0].payload.itemUrl).toBe("https://example.com/doc-without-source?q=1");
    expect(points[0].payload.fetchedUrl).toBeUndefined();
  });

  it("auto-sets source from URL when not provided", async () => {
    const urlFetch = await import("./url-fetch.js");
    const urlExtract = await import("./url-extract.js");
    const mockFetchUrls = (urlFetch as any).__mockFetchUrls;
    const mockExtractContentAsync = (urlExtract as any).__mockExtractContentAsync;

    mockFetchUrls.mockResolvedValue({
      results: new Map([
        [
          "https://example.com/path/to/article",
          {
            url: "https://example.com/path/to/article",
            resolvedUrl: "https://example.com/path/to/article",
            contentType: "text/html",
            status: 200,
            body: Buffer.from("<html>content</html>"),
            fetchedAt: "2024-01-01T00:00:00Z",
          },
        ],
      ]),
      errors: [],
    });

    mockExtractContentAsync.mockResolvedValue({
      text: "Content",
      strategy: "readability",
      contentType: "text/html",
    });

    const upsertMock = vi.fn(async () => {});
    const deps = makeDeps({ upsert: upsertMock });
    const request: IngestRequest = {
      items: [{ url: "https://example.com/path/to/article" }],
    };

    await ingest(request, deps);

    const points = (upsertMock.mock.calls[0] as any)[1];
    expect(points).toBeDefined();
    expect(points[0].payload.source).toBe("https://example.com/path/to/article");

    mockFetchUrls.mockClear();
    mockExtractContentAsync.mockClear();
  });

  it("handles mixed batch of text and URL items", async () => {
    const urlFetch = await import("./url-fetch.js");
    const urlExtract = await import("./url-extract.js");
    const mockFetchUrls = (urlFetch as any).__mockFetchUrls;
    const mockExtractContentAsync = (urlExtract as any).__mockExtractContentAsync;

    mockFetchUrls.mockResolvedValue({
      results: new Map([
        [
          "https://example.com/doc",
          {
            url: "https://example.com/doc",
            resolvedUrl: "https://example.com/doc",
            contentType: "text/plain",
            status: 200,
            body: Buffer.from("Fetched content"),
            fetchedAt: "2024-01-01T00:00:00Z",
          },
        ],
      ]),
      errors: [],
    });

    mockExtractContentAsync.mockResolvedValue({
      text: "Fetched content",
      strategy: "passthrough",
      contentType: "text/plain",
    });

    const upsertMock = vi.fn(async () => {});
    const deps = makeDeps({ upsert: upsertMock });
    const request: IngestRequest = {
      items: [
        { text: "Direct text item", source: "direct.txt" },
        { url: "https://example.com/doc" },
      ],
    };

    const result = await ingest(request, deps);

    // Both items should be processed
    expect(result.upserted).toBe(2);
    expect(result.fetched).toBe(1);

    // Verify fetch was only called for URL item
    expect(mockFetchUrls).toHaveBeenCalledWith(["https://example.com/doc"]);

    mockFetchUrls.mockClear();
    mockExtractContentAsync.mockClear();
  });

  it("reports fetch failures in errors array", async () => {
    const urlFetch = await import("./url-fetch.js");
    const mockFetchUrls = (urlFetch as any).__mockFetchUrls;

    mockFetchUrls.mockResolvedValue({
      results: new Map(),
      errors: [
        {
          url: "https://example.com/notfound",
          status: 404,
          reason: "fetch_failed",
        },
      ],
    });

    const deps = makeDeps();
    const request: IngestRequest = {
      items: [{ url: "https://example.com/notfound" }],
    };

    const result = await ingest(request, deps);

    // No items should be upserted
    expect(result.upserted).toBe(0);
    expect(result.fetched).toBeUndefined();

    // Error should be reported
    expect(result.errors).toBeDefined();
    expect(result.errors).toHaveLength(1);
    expect(result.errors![0].url).toBe("https://example.com/notfound");
    expect(result.errors![0].status).toBe(404);
    expect(result.errors![0].reason).toBe("fetch_failed");

    mockFetchUrls.mockClear();
  });

  it("reports unsupported content type in errors array", async () => {
    const urlFetch = await import("./url-fetch.js");
    const urlExtract = await import("./url-extract.js");
    const mockFetchUrls = (urlFetch as any).__mockFetchUrls;
    const mockExtractContentAsync = (urlExtract as any).__mockExtractContentAsync;

    mockFetchUrls.mockResolvedValue({
      results: new Map([
        [
          "https://example.com/binary",
          {
            url: "https://example.com/binary",
            resolvedUrl: "https://example.com/binary",
            contentType: "application/octet-stream",
            status: 200,
            body: Buffer.from([0x00, 0x01, 0x02]),
            fetchedAt: "2024-01-01T00:00:00Z",
          },
        ],
      ]),
      errors: [],
    });

    mockExtractContentAsync.mockResolvedValue({
      text: null,
      strategy: "metadata-only",
      contentType: "application/octet-stream",
    });

    const deps = makeDeps();
    const request: IngestRequest = {
      items: [{ url: "https://example.com/binary" }],
    };

    const result = await ingest(request, deps);

    // No items should be upserted
    expect(result.upserted).toBe(0);
    expect(result.fetched).toBeUndefined();

    // Error should be reported with unsupported content type reason
    expect(result.errors).toBeDefined();
    expect(result.errors).toHaveLength(1);
    expect(result.errors![0].url).toBe("https://example.com/binary");
    expect(result.errors![0].status).toBe(200);
    expect(result.errors![0].reason).toBe("unsupported_content_type: application/octet-stream");

    mockFetchUrls.mockClear();
    mockExtractContentAsync.mockClear();
  });

  it("maintains backward compatibility with text-only items", async () => {
    const urlFetch = await import("./url-fetch.js");
    const mockFetchUrls = (urlFetch as any).__mockFetchUrls;
    
    // Clear previous mock calls
    mockFetchUrls.mockClear();

    const upsertMock = vi.fn(async () => {});
    const deps = makeDeps({ upsert: upsertMock });
    const request: IngestRequest = {
      items: [
        { text: "hello world", source: "test.txt" },
        { text: "another doc", source: "doc.txt", id: "doc-1" },
      ],
    };

    const result = await ingest(request, deps);

    // Fetch should not be called
    expect(mockFetchUrls).not.toHaveBeenCalled();

    // Standard behavior should be preserved
    expect(result.upserted).toBe(2);
    expect(result.fetched).toBeUndefined();
    expect(result.errors).toBeUndefined();

    const points = (upsertMock.mock.calls[0] as any)[1];
    expect(points).toBeDefined();
    expect(points[0].payload.text).toBe("hello world");
    expect(points[0].payload.source).toBe("test.txt");
  });
});
