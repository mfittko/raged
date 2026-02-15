import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import { registerAuth } from "../auth.js";
import { registerErrorHandler } from "../errors.js";
import { ingest } from "./ingest.js";
import { validateIngestRequest } from "./ingest-validation.js";
import { ingestSchema } from "../schemas.js";
import type { IngestRequest, IngestDeps } from "./ingest.js";

// Mock the redis module
vi.mock("../redis.js", () => {
  const mockEnqueue = vi.fn(async () => {});
  const mockIsEnabled = vi.fn(() => false);
  return {
    enqueueEnrichment: mockEnqueue,
    isEnrichmentEnabled: mockIsEnabled,
    __mockEnqueue: mockEnqueue,
    __mockIsEnabled: mockIsEnabled,
  };
});

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

function buildIntegrationTestApp(options?: {
  ingestDeps?: Partial<IngestDeps>;
}) {
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerAuth(app);

  const defaultIngestDeps: IngestDeps = {
    embed: vi.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3])),
    ensureCollection: vi.fn(async () => {}),
    upsert: vi.fn(async () => {}),
    collectionName: vi.fn((name?: string) => name || "docs"),
  };

  const ingestDeps = { ...defaultIngestDeps, ...options?.ingestDeps };

  app.post("/ingest", { 
    schema: ingestSchema,
    preValidation: async (req, reply) => {
      const body = req.body as IngestRequest;
      const validationError = validateIngestRequest(body);
      if (validationError) {
        return reply.status(400).send(validationError);
      }
    }
  }, async (req) => {
    const body = req.body as IngestRequest;
    return ingest(body, ingestDeps);
  });

  return { app, ingestDeps };
}

describe("ingest integration tests", () => {
  beforeEach(() => {
    // Reset all mocks before each test
    vi.clearAllMocks();
  });

  describe("happy path - URL ingestion", () => {
    it("HTML URL → Readability extraction → chunked and upserted with correct metadata", async () => {
      const urlFetch = await import("./url-fetch.js");
      const urlExtract = await import("./url-extract.js");
      const mockFetchUrls = (urlFetch as any).__mockFetchUrls;
      const mockExtractContentAsync = (urlExtract as any).__mockExtractContentAsync;

      mockFetchUrls.mockResolvedValue({
        results: new Map([
          [
            "https://example.com/article",
            {
              url: "https://example.com/article",
              resolvedUrl: "https://example.com/article",
              contentType: "text/html; charset=utf-8",
              status: 200,
              body: Buffer.from("<html><body><article>Article content here</article></body></html>"),
              fetchedAt: "2024-01-01T00:00:00Z",
            },
          ],
        ]),
        errors: [],
      });

      mockExtractContentAsync.mockResolvedValue({
        text: "Article content here",
        title: "Example Article",
        strategy: "readability",
        contentType: "text/html",
      });

      const upsertMock = vi.fn(async () => {});
      const { app } = buildIntegrationTestApp({
        ingestDeps: { upsert: upsertMock },
      });

      const res = await app.inject({
        method: "POST",
        url: "/ingest",
        payload: {
          items: [{ url: "https://example.com/article", docType: "article" }],
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ok).toBe(true);
      expect(body.upserted).toBe(1);
      expect(body.fetched).toBe(1);

      // Verify fetch metadata in upserted point
      expect(upsertMock).toHaveBeenCalled();
      const points = (upsertMock.mock.calls[0] as any)[1];
      expect(points[0].payload.text).toBe("Article content here");
      expect(points[0].payload.fetchedUrl).toBe("https://example.com/article");
      expect(points[0].payload.resolvedUrl).toBe("https://example.com/article");
      expect(points[0].payload.contentType).toBe("text/html; charset=utf-8");
      expect(points[0].payload.fetchStatus).toBe(200);
      expect(points[0].payload.extractionStrategy).toBe("readability");
      expect(points[0].payload.extractedTitle).toBe("Example Article");
      expect(points[0].payload.fetchedAt).toBe("2024-01-01T00:00:00Z");

      await app.close();
    });

    it("PDF URL → pdf-parse extraction → chunked with page metadata", async () => {
      const urlFetch = await import("./url-fetch.js");
      const urlExtract = await import("./url-extract.js");
      const mockFetchUrls = (urlFetch as any).__mockFetchUrls;
      const mockExtractContentAsync = (urlExtract as any).__mockExtractContentAsync;

      mockFetchUrls.mockResolvedValue({
        results: new Map([
          [
            "https://example.com/document.pdf",
            {
              url: "https://example.com/document.pdf",
              resolvedUrl: "https://example.com/document.pdf",
              contentType: "application/pdf",
              status: 200,
              body: Buffer.from("fake-pdf-content"),
              fetchedAt: "2024-01-01T00:00:00Z",
            },
          ],
        ]),
        errors: [],
      });

      mockExtractContentAsync.mockResolvedValue({
        text: "PDF text content extracted",
        strategy: "pdf-parse",
        contentType: "application/pdf",
        metadata: { pageCount: 5 },
      });

      const upsertMock = vi.fn(async () => {});
      const { app } = buildIntegrationTestApp({
        ingestDeps: { upsert: upsertMock },
      });

      const res = await app.inject({
        method: "POST",
        url: "/ingest",
        payload: {
          items: [{ url: "https://example.com/document.pdf" }],
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ok).toBe(true);
      expect(body.upserted).toBe(1);
      expect(body.fetched).toBe(1);

      const points = (upsertMock.mock.calls[0] as any)[1];
      expect(points[0].payload.text).toBe("PDF text content extracted");
      expect(points[0].payload.extractionStrategy).toBe("pdf-parse");

      await app.close();
    });

    it("plain text URL → passthrough → ingested as-is", async () => {
      const urlFetch = await import("./url-fetch.js");
      const urlExtract = await import("./url-extract.js");
      const mockFetchUrls = (urlFetch as any).__mockFetchUrls;
      const mockExtractContentAsync = (urlExtract as any).__mockExtractContentAsync;

      mockFetchUrls.mockResolvedValue({
        results: new Map([
          [
            "https://example.com/note.txt",
            {
              url: "https://example.com/note.txt",
              resolvedUrl: "https://example.com/note.txt",
              contentType: "text/plain",
              status: 200,
              body: Buffer.from("Plain text content"),
              fetchedAt: "2024-01-01T00:00:00Z",
            },
          ],
        ]),
        errors: [],
      });

      mockExtractContentAsync.mockResolvedValue({
        text: "Plain text content",
        strategy: "passthrough",
        contentType: "text/plain",
      });

      const upsertMock = vi.fn(async () => {});
      const { app } = buildIntegrationTestApp({
        ingestDeps: { upsert: upsertMock },
      });

      const res = await app.inject({
        method: "POST",
        url: "/ingest",
        payload: {
          items: [{ url: "https://example.com/note.txt" }],
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ok).toBe(true);
      expect(body.upserted).toBe(1);

      const points = (upsertMock.mock.calls[0] as any)[1];
      expect(points[0].payload.text).toBe("Plain text content");
      expect(points[0].payload.extractionStrategy).toBe("passthrough");

      await app.close();
    });

    it("JSON URL → pretty-printed → ingested as text", async () => {
      const urlFetch = await import("./url-fetch.js");
      const urlExtract = await import("./url-extract.js");
      const mockFetchUrls = (urlFetch as any).__mockFetchUrls;
      const mockExtractContentAsync = (urlExtract as any).__mockExtractContentAsync;

      const jsonData = { key: "value", nested: { prop: 123 } };
      mockFetchUrls.mockResolvedValue({
        results: new Map([
          [
            "https://api.example.com/data.json",
            {
              url: "https://api.example.com/data.json",
              resolvedUrl: "https://api.example.com/data.json",
              contentType: "application/json",
              status: 200,
              body: Buffer.from(JSON.stringify(jsonData)),
              fetchedAt: "2024-01-01T00:00:00Z",
            },
          ],
        ]),
        errors: [],
      });

      mockExtractContentAsync.mockResolvedValue({
        text: JSON.stringify(jsonData, null, 2),
        strategy: "json-pretty",
        contentType: "application/json",
      });

      const upsertMock = vi.fn(async () => {});
      const { app } = buildIntegrationTestApp({
        ingestDeps: { upsert: upsertMock },
      });

      const res = await app.inject({
        method: "POST",
        url: "/ingest",
        payload: {
          items: [{ url: "https://api.example.com/data.json" }],
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ok).toBe(true);
      expect(body.upserted).toBe(1);

      const points = (upsertMock.mock.calls[0] as any)[1];
      expect(points[0].payload.text).toBe(JSON.stringify(jsonData, null, 2));
      expect(points[0].payload.extractionStrategy).toBe("json-pretty");

      await app.close();
    });
  });

  describe("mixed batches", () => {
    it("3 text items + 2 URL items in one request → all 5 processed", async () => {
      const urlFetch = await import("./url-fetch.js");
      const urlExtract = await import("./url-extract.js");
      const mockFetchUrls = (urlFetch as any).__mockFetchUrls;
      const mockExtractContentAsync = (urlExtract as any).__mockExtractContentAsync;

      mockFetchUrls.mockResolvedValue({
        results: new Map([
          [
            "https://example.com/url1",
            {
              url: "https://example.com/url1",
              resolvedUrl: "https://example.com/url1",
              contentType: "text/plain",
              status: 200,
              body: Buffer.from("URL content 1"),
              fetchedAt: "2024-01-01T00:00:00Z",
            },
          ],
          [
            "https://example.com/url2",
            {
              url: "https://example.com/url2",
              resolvedUrl: "https://example.com/url2",
              contentType: "text/plain",
              status: 200,
              body: Buffer.from("URL content 2"),
              fetchedAt: "2024-01-01T00:00:00Z",
            },
          ],
        ]),
        errors: [],
      });

      mockExtractContentAsync
        .mockResolvedValueOnce({
          text: "URL content 1",
          strategy: "passthrough",
          contentType: "text/plain",
        })
        .mockResolvedValueOnce({
          text: "URL content 2",
          strategy: "passthrough",
          contentType: "text/plain",
        });

      const upsertMock = vi.fn(async () => {});
      const { app } = buildIntegrationTestApp({
        ingestDeps: { upsert: upsertMock },
      });

      const res = await app.inject({
        method: "POST",
        url: "/ingest",
        payload: {
          items: [
            { text: "Text item 1", source: "doc1.txt" },
            { text: "Text item 2", source: "doc2.txt" },
            { text: "Text item 3", source: "doc3.txt" },
            { url: "https://example.com/url1" },
            { url: "https://example.com/url2" },
          ],
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ok).toBe(true);
      expect(body.upserted).toBe(5);
      expect(body.fetched).toBe(2);

      await app.close();
    });

    it("2 URL items + 1 failing URL → 2 succeed, 1 error, upserted reflects successes", async () => {
      const urlFetch = await import("./url-fetch.js");
      const urlExtract = await import("./url-extract.js");
      const mockFetchUrls = (urlFetch as any).__mockFetchUrls;
      const mockExtractContentAsync = (urlExtract as any).__mockExtractContentAsync;

      mockFetchUrls.mockResolvedValue({
        results: new Map([
          [
            "https://example.com/success1",
            {
              url: "https://example.com/success1",
              resolvedUrl: "https://example.com/success1",
              contentType: "text/plain",
              status: 200,
              body: Buffer.from("Success 1"),
              fetchedAt: "2024-01-01T00:00:00Z",
            },
          ],
          [
            "https://example.com/success2",
            {
              url: "https://example.com/success2",
              resolvedUrl: "https://example.com/success2",
              contentType: "text/plain",
              status: 200,
              body: Buffer.from("Success 2"),
              fetchedAt: "2024-01-01T00:00:00Z",
            },
          ],
        ]),
        errors: [
          {
            url: "https://example.com/fail",
            status: 404,
            reason: "fetch_failed",
          },
        ],
      });

      mockExtractContentAsync
        .mockResolvedValueOnce({
          text: "Success 1",
          strategy: "passthrough",
          contentType: "text/plain",
        })
        .mockResolvedValueOnce({
          text: "Success 2",
          strategy: "passthrough",
          contentType: "text/plain",
        });

      const upsertMock = vi.fn(async () => {});
      const { app } = buildIntegrationTestApp({
        ingestDeps: { upsert: upsertMock },
      });

      const res = await app.inject({
        method: "POST",
        url: "/ingest",
        payload: {
          items: [
            { url: "https://example.com/success1" },
            { url: "https://example.com/success2" },
            { url: "https://example.com/fail" },
          ],
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ok).toBe(true);
      expect(body.upserted).toBe(2);
      expect(body.fetched).toBe(2);
      expect(body.errors).toHaveLength(1);
      expect(body.errors[0].url).toBe("https://example.com/fail");
      expect(body.errors[0].status).toBe(404);
      expect(body.errors[0].reason).toBe("fetch_failed");

      await app.close();
    });
  });

  describe("error cases", () => {
    it("URL that times out → error with reason: timeout", async () => {
      const urlFetch = await import("./url-fetch.js");
      const mockFetchUrls = (urlFetch as any).__mockFetchUrls;

      mockFetchUrls.mockResolvedValue({
        results: new Map(),
        errors: [
          {
            url: "https://example.com/timeout",
            status: null,
            reason: "timeout",
          },
        ],
      });

      const { app } = buildIntegrationTestApp();

      const res = await app.inject({
        method: "POST",
        url: "/ingest",
        payload: {
          items: [{ url: "https://example.com/timeout" }],
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ok).toBe(true);
      expect(body.upserted).toBe(0);
      expect(body.errors).toHaveLength(1);
      expect(body.errors[0].url).toBe("https://example.com/timeout");
      expect(body.errors[0].status).toBe(null);
      expect(body.errors[0].reason).toBe("timeout");

      await app.close();
    });

    it("URL returning 404 → error with reason: fetch_failed, status: 404", async () => {
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

      const { app } = buildIntegrationTestApp();

      const res = await app.inject({
        method: "POST",
        url: "/ingest",
        payload: {
          items: [{ url: "https://example.com/notfound" }],
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ok).toBe(true);
      expect(body.upserted).toBe(0);
      expect(body.errors).toHaveLength(1);
      expect(body.errors[0].status).toBe(404);
      expect(body.errors[0].reason).toBe("fetch_failed");

      await app.close();
    });

    it("URL with unsupported content type → error with reason: unsupported_content_type", async () => {
      const urlFetch = await import("./url-fetch.js");
      const urlExtract = await import("./url-extract.js");
      const mockFetchUrls = (urlFetch as any).__mockFetchUrls;
      const mockExtractContentAsync = (urlExtract as any).__mockExtractContentAsync;

      mockFetchUrls.mockResolvedValue({
        results: new Map([
          [
            "https://example.com/video.mp4",
            {
              url: "https://example.com/video.mp4",
              resolvedUrl: "https://example.com/video.mp4",
              contentType: "video/mp4",
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
        contentType: "video/mp4",
      });

      const { app } = buildIntegrationTestApp();

      const res = await app.inject({
        method: "POST",
        url: "/ingest",
        payload: {
          items: [{ url: "https://example.com/video.mp4" }],
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ok).toBe(true);
      expect(body.upserted).toBe(0);
      expect(body.errors).toHaveLength(1);
      expect(body.errors[0].url).toBe("https://example.com/video.mp4");
      expect(body.errors[0].status).toBe(200);
      expect(body.errors[0].reason).toBe("unsupported_content_type: video/mp4");

      await app.close();
    });

    it("SSRF attempt (private IP URL) → error with reason: ssrf_blocked", async () => {
      const urlFetch = await import("./url-fetch.js");
      const mockFetchUrls = (urlFetch as any).__mockFetchUrls;

      mockFetchUrls.mockResolvedValue({
        results: new Map(),
        errors: [
          {
            url: "http://192.168.1.1/admin",
            status: null,
            reason: "ssrf_blocked",
          },
        ],
      });

      const { app } = buildIntegrationTestApp();

      const res = await app.inject({
        method: "POST",
        url: "/ingest",
        payload: {
          items: [{ url: "http://192.168.1.1/admin" }],
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ok).toBe(true);
      expect(body.upserted).toBe(0);
      expect(body.errors).toHaveLength(1);
      expect(body.errors[0].url).toBe("http://192.168.1.1/admin");
      expect(body.errors[0].reason).toBe("ssrf_blocked");

      await app.close();
    });

    it(">50 URL items in one request → 400 validation error", async () => {
      const { app } = buildIntegrationTestApp();

      const items = Array.from({ length: 51 }, (_, i) => ({
        url: `https://example.com/page${i}`,
      }));

      const res = await app.inject({
        method: "POST",
        url: "/ingest",
        payload: { items },
      });

      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toContain("maximum 50 URL items");

      await app.close();
    });
  });

  describe("backward compatibility", () => {
    it("text-only ingest request (no url field) → identical behavior", async () => {
      const upsertMock = vi.fn(async () => {});
      const { app } = buildIntegrationTestApp({
        ingestDeps: { upsert: upsertMock },
      });

      const res = await app.inject({
        method: "POST",
        url: "/ingest",
        payload: {
          items: [
            { text: "hello world", source: "test.txt" },
            { text: "another doc", source: "doc.txt" },
          ],
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ok).toBe(true);
      expect(body.upserted).toBe(2);
      expect(body.fetched).toBeUndefined();
      expect(body.errors).toBeUndefined();

      const points = (upsertMock.mock.calls[0] as any)[1];
      expect(points[0].payload.text).toBe("hello world");
      expect(points[0].payload.source).toBe("test.txt");
      expect(points[0].payload.fetchedUrl).toBeUndefined();

      await app.close();
    });

    it("item with both text and url → text used, url stored in metadata, no fetch", async () => {
      const urlFetch = await import("./url-fetch.js");
      const mockFetchUrls = (urlFetch as any).__mockFetchUrls;
      mockFetchUrls.mockClear();

      const upsertMock = vi.fn(async () => {});
      const { app } = buildIntegrationTestApp({
        ingestDeps: { upsert: upsertMock },
      });

      const res = await app.inject({
        method: "POST",
        url: "/ingest",
        payload: {
          items: [
            {
              text: "Provided text content",
              url: "https://example.com/doc",
              source: "my-source",
            },
          ],
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ok).toBe(true);
      expect(body.upserted).toBe(1);
      expect(body.fetched).toBeUndefined();

      // Fetch should not be called
      expect(mockFetchUrls).not.toHaveBeenCalled();

      // Verify text was used and url stored in metadata
      const points = (upsertMock.mock.calls[0] as any)[1];
      expect(points[0].payload.text).toBe("Provided text content");
      expect(points[0].payload.source).toBe("my-source");
      expect(points[0].payload.itemUrl).toBe("https://example.com/doc");
      expect(points[0].payload.fetchedUrl).toBeUndefined();

      await app.close();
    });
  });

  describe("metadata verification", () => {
    it("URL-fetched item has all required fetch metadata in Qdrant payload", async () => {
      const urlFetch = await import("./url-fetch.js");
      const urlExtract = await import("./url-extract.js");
      const mockFetchUrls = (urlFetch as any).__mockFetchUrls;
      const mockExtractContentAsync = (urlExtract as any).__mockExtractContentAsync;

      mockFetchUrls.mockResolvedValue({
        results: new Map([
          [
            "https://example.com/test",
            {
              url: "https://example.com/test",
              resolvedUrl: "https://example.com/test",
              contentType: "text/html",
              status: 200,
              body: Buffer.from("<html>content</html>"),
              fetchedAt: "2024-01-01T12:00:00Z",
            },
          ],
        ]),
        errors: [],
      });

      mockExtractContentAsync.mockResolvedValue({
        text: "Extracted content",
        title: "Test Page",
        strategy: "readability",
        contentType: "text/html",
      });

      const upsertMock = vi.fn(async () => {});
      const { app } = buildIntegrationTestApp({
        ingestDeps: { upsert: upsertMock },
      });

      const res = await app.inject({
        method: "POST",
        url: "/ingest",
        payload: {
          items: [{ url: "https://example.com/test" }],
        },
      });

      expect(res.statusCode).toBe(200);

      const points = (upsertMock.mock.calls[0] as any)[1];
      const payload = points[0].payload;

      // Verify all required fetch metadata fields
      expect(payload.fetchedUrl).toBe("https://example.com/test");
      expect(payload.resolvedUrl).toBe("https://example.com/test");
      expect(payload.contentType).toBe("text/html");
      expect(payload.fetchStatus).toBe(200);
      expect(payload.fetchedAt).toBe("2024-01-01T12:00:00Z");
      expect(payload.extractionStrategy).toBe("readability");
      expect(payload.extractedTitle).toBe("Test Page");

      await app.close();
    });

    it("redirect chain → resolvedUrl differs from fetchedUrl", async () => {
      const urlFetch = await import("./url-fetch.js");
      const urlExtract = await import("./url-extract.js");
      const mockFetchUrls = (urlFetch as any).__mockFetchUrls;
      const mockExtractContentAsync = (urlExtract as any).__mockExtractContentAsync;

      mockFetchUrls.mockResolvedValue({
        results: new Map([
          [
            "https://example.com/redirect",
            {
              url: "https://example.com/redirect",
              resolvedUrl: "https://example.com/final-destination",
              contentType: "text/html",
              status: 200,
              body: Buffer.from("<html>final content</html>"),
              fetchedAt: "2024-01-01T12:00:00Z",
            },
          ],
        ]),
        errors: [],
      });

      mockExtractContentAsync.mockResolvedValue({
        text: "Final content",
        strategy: "readability",
        contentType: "text/html",
      });

      const upsertMock = vi.fn(async () => {});
      const { app } = buildIntegrationTestApp({
        ingestDeps: { upsert: upsertMock },
      });

      const res = await app.inject({
        method: "POST",
        url: "/ingest",
        payload: {
          items: [{ url: "https://example.com/redirect" }],
        },
      });

      expect(res.statusCode).toBe(200);

      const points = (upsertMock.mock.calls[0] as any)[1];
      const payload = points[0].payload;

      // Verify redirect chain is captured
      expect(payload.fetchedUrl).toBe("https://example.com/redirect");
      expect(payload.resolvedUrl).toBe("https://example.com/final-destination");
      expect(payload.source).toBe("https://example.com/final-destination");

      await app.close();
    });
  });
});
