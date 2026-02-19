import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Readable } from "node:stream";
import { buildApp } from "./server.js";

// Mock the db module
vi.mock("./db.js", () => ({
  getPool: vi.fn(() => ({
    connect: vi.fn(async () => ({
      query: vi.fn(async (sql: string) => {
        if (sql.includes("RETURNING id")) {
          return { rows: [{ id: "test-doc-id" }] };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    })),
    query: vi.fn(async () => ({ rows: [] })),
  })),
  query: vi.fn(async () => ({ rows: [] })),
  runMigrations: vi.fn(),
  closePool: vi.fn(),
}));

// Mock embeddings module
vi.mock("./embeddings.js", () => ({
  embed: vi.fn(async (texts: string[]) =>
    texts.map(() => Array(768).fill(0.1))
  ),
}));

// Mock ollama module (used by query path)
vi.mock("./ollama.js", () => ({
  embed: vi.fn(async (texts: string[]) =>
    texts.map(() => Array(768).fill(0.1))
  ),
}));

vi.mock("./blob-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./blob-store.js")>();
  return {
    ...actual,
    downloadRawBlobStream: vi.fn(async () => ({
      stream: Readable.from([Buffer.from("blob payload")]),
      contentLength: null,
      contentType: null,
    })),
    downloadRawBlob: vi.fn(async () => Buffer.from("blob payload")),
  };
});

describe("API integration tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("GET /healthz", () => {
    it("returns 200 with { ok: true }", async () => {
      const app = buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/healthz",
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      await app.close();
    });
  });

  describe("POST /ingest", () => {
    it("returns 200 with upsert count for valid request", async () => {
      const app = buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/ingest",
        headers: {
          authorization: "Bearer test-token",
        },
        payload: {
          collection: "test-col",
          items: [
            { text: "hello world", source: "test.txt" },
            { text: "foo bar", source: "other.txt" },
          ],
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ok).toBe(true);
      expect(body.upserted).toBeGreaterThan(0);
      await app.close();
    });

    it("returns 400 for missing items", async () => {
      const app = buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/ingest",
        headers: {
          authorization: "Bearer test-token",
        },
        payload: {
          collection: "test-col",
        },
      });

      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it("returns 400 for empty items array", async () => {
      const app = buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/ingest",
        headers: {
          authorization: "Bearer test-token",
        },
        payload: {
          collection: "test-col",
          items: [],
        },
      });

      expect(res.statusCode).toBe(400);
      await app.close();
    });
  });

  describe("POST /query", () => {
    it("returns 200 with results for valid query", async () => {
      const { getPool } = await import("./db.js");
      (getPool as any).mockReturnValueOnce({
        query: vi.fn(async () => ({
          rows: [
            {
              chunk_id: "test-id:0",
              distance: 0.1,
              text: "hello world",
              source: "test.txt",
              chunk_index: 0,
              base_id: "test-id",
              doc_type: "text",
              repo_id: null,
              repo_url: null,
              path: null,
              lang: null,
              item_url: null,
              tier1_meta: {},
              tier2_meta: null,
              tier3_meta: null,
              doc_summary: null,
              doc_summary_short: null,
              doc_summary_medium: null,
              doc_summary_long: null,
              payload_checksum: null,
            },
          ],
        })),
      });

      const app = buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/query",
        headers: {
          authorization: "Bearer test-token",
        },
        payload: {
          query: "test query",
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ok).toBe(true);
      expect(body.results).toBeDefined();
      await app.close();
    });

    it("returns 400 for missing query", async () => {
      const app = buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/query",
        headers: {
          authorization: "Bearer test-token",
        },
        payload: {},
      });

      expect(res.statusCode).toBe(400);
      await app.close();
    });
  });

  describe("auth integration", () => {
    const ORIGINAL_TOKEN = process.env.RAGED_API_TOKEN;

    afterEach(() => {
      if (ORIGINAL_TOKEN === undefined) {
        delete process.env.RAGED_API_TOKEN;
      } else {
        process.env.RAGED_API_TOKEN = ORIGINAL_TOKEN;
      }
    });

    it("blocks /ingest without token when auth is enabled", async () => {
      process.env.RAGED_API_TOKEN = "test-secret";
      const app = buildApp();

      const res = await app.inject({
        method: "POST",
        url: "/ingest",
        payload: {
          items: [{ text: "hello", source: "test.txt" }],
        },
      });

      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: "Unauthorized" });
      await app.close();
    });

    it("allows /ingest with correct token", async () => {
      process.env.RAGED_API_TOKEN = "test-secret";
      const app = buildApp();

      const res = await app.inject({
        method: "POST",
        url: "/ingest",
        headers: {
          authorization: "Bearer test-secret",
        },
        payload: {
          items: [{ text: "hello", source: "test.txt" }],
        },
      });

      expect(res.statusCode).toBe(200);
      await app.close();
    });

    it("always allows /healthz without token", async () => {
      process.env.RAGED_API_TOKEN = "test-secret";
      const app = buildApp();

      const res = await app.inject({
        method: "GET",
        url: "/healthz",
      });

      expect(res.statusCode).toBe(200);
      await app.close();
    });
  });

  describe("enrichment endpoints", () => {
    it("GET /enrichment/status/:baseId returns status", async () => {
      const { getPool } = await import("./db.js");
      (getPool as any).mockReturnValueOnce({
        query: vi.fn(async () => ({
          rows: [
            {
              enrichment_status: "enriched",
              enriched_at: new Date().toISOString(),
              tier2_meta: null,
              tier3_meta: null,
            },
          ],
        })),
      });

      const app = buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/enrichment/status/test-base-id",
        headers: {
          authorization: "Bearer test-token",
        },
      });

      expect(res.statusCode).toBe(200);
      await app.close();
    });

    it("GET /enrichment/stats returns stats", async () => {
      const { getPool } = await import("./db.js");
      (getPool as any).mockReturnValueOnce({
        query: vi.fn(async () => ({
          rows: [
            { status: "pending", count: 10 },
          ],
        })),
      });

      const app = buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/enrichment/stats",
        headers: {
          authorization: "Bearer test-token",
        },
      });

      expect(res.statusCode).toBe(200);
      await app.close();
    });

    it("POST /enrichment/enqueue returns enqueue result", async () => {
      const { getPool } = await import("./db.js");
      (getPool as any).mockReturnValueOnce({
        query: vi.fn(async () => ({ rows: [] })),
        connect: vi.fn(async () => ({
          query: vi.fn(async () => ({ rows: [] })),
          release: vi.fn(),
        })),
      });

      const app = buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/enrichment/enqueue",
        headers: {
          authorization: "Bearer test-token",
        },
        payload: {},
      });

      expect(res.statusCode).toBe(200);
      await app.close();
    });

    it("POST /enrichment/clear handles null body safely", async () => {
      const app = buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/enrichment/clear",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        payload: "null",
      });

      expect(res.statusCode).toBe(400);
      await app.close();
    });
  });

  describe("graph endpoints", () => {
    it("GET /graph/entity/:name returns entity data", async () => {
      const { getPool } = await import("./db.js");
      (getPool as any).mockReturnValueOnce({
        query: vi.fn(async () => ({
          rows: [
            {
              name: "Test Entity",
              type: "person",
              description: "A test entity",
              mention_count: 5,
            },
          ],
        })),
      });

      const app = buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/graph/entity/Test%20Entity",
        headers: {
          authorization: "Bearer test-token",
        },
      });

      expect(res.statusCode).toBe(200);
      await app.close();
    });
  });

  describe("GET /collections", () => {
    it("returns collection stats", async () => {
      const { getPool } = await import("./db.js");
      (getPool as any).mockReturnValueOnce({
        query: vi.fn(async () => ({
          rows: [
            {
              collection: "docs",
              document_count: 5,
              chunk_count: 20,
              enriched_chunk_count: 15,
              last_seen_at: "2024-01-01T00:00:00.000Z",
            },
          ],
        })),
      });

      const app = buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/collections",
        headers: {
          authorization: "Bearer test-token",
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ok).toBe(true);
      expect(Array.isArray(body.collections)).toBe(true);
      expect(body.collections[0].collection).toBe("docs");
      expect(body.collections[0].documentCount).toBe(5);
      await app.close();
    });
  });

  describe("POST /query/download-first", () => {
    it("returns 404 when no results found", async () => {
      const { getPool } = await import("./db.js");
      (getPool as any).mockReturnValueOnce({
        query: vi.fn(async () => ({ rows: [] })),
      });

      const app = buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/query/download-first",
        headers: { authorization: "Bearer test-token" },
        payload: { query: "nothing matches" },
      });

      expect(res.statusCode).toBe(404);
      await app.close();
    });

    it("returns binary data when document found with raw_data", async () => {
      const { getPool } = await import("./db.js");
      const chunkRow = {
        chunk_id: "test-id:0",
        distance: 0.1,
        text: "hello world",
        source: "report.pdf",
        chunk_index: 0,
        base_id: "test-base-id",
        doc_type: "pdf",
        repo_id: null,
        repo_url: null,
        path: null,
        lang: null,
        item_url: null,
        tier1_meta: {},
        tier2_meta: null,
        tier3_meta: null,
        doc_summary: null,
        doc_summary_short: null,
        doc_summary_medium: null,
        doc_summary_long: null,
        payload_checksum: null,
      };

      // First getPool(): vector search
      (getPool as any).mockReturnValueOnce({
        query: vi.fn(async () => ({ rows: [chunkRow] })),
      });
      // Second getPool(): document lookup
      (getPool as any).mockReturnValueOnce({
        query: vi.fn(async () => ({
          rows: [
            {
              raw_data: Buffer.from("PDF binary content"),
              raw_key: null,
              source: "report.pdf",
              mime_type: "application/pdf",
            },
          ],
        })),
      });

      const app = buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/query/download-first",
        headers: { authorization: "Bearer test-token" },
        payload: { query: "hello world" },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("application/pdf");
      expect(res.headers["content-disposition"]).toContain("report.pdf");
      expect(res.headers["x-raged-source"]).toBe("report.pdf");
      await app.close();
    });

    it("returns 200 for empty raw_data buffer", async () => {
      const { getPool } = await import("./db.js");
      const chunkRow = {
        chunk_id: "test-id:0",
        distance: 0.1,
        text: "hello world",
        source: "empty.txt",
        chunk_index: 0,
        base_id: "test-base-id",
        doc_type: "text",
        repo_id: null,
        repo_url: null,
        path: null,
        lang: null,
        item_url: null,
        tier1_meta: {},
        tier2_meta: null,
        tier3_meta: null,
        doc_summary: null,
        doc_summary_short: null,
        doc_summary_medium: null,
        doc_summary_long: null,
        payload_checksum: null,
      };

      (getPool as any).mockReturnValueOnce({
        query: vi.fn(async () => ({ rows: [chunkRow] })),
      });
      (getPool as any).mockReturnValueOnce({
        query: vi.fn(async () => ({
          rows: [
            {
              raw_data: Buffer.alloc(0),
              raw_key: null,
              source: "empty.txt",
              mime_type: "text/plain",
            },
          ],
        })),
      });

      const app = buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/query/download-first",
        headers: { authorization: "Bearer test-token" },
        payload: { query: "hello world" },
      });

      expect(res.statusCode).toBe(200);
      expect(res.body).toBe("");
      await app.close();
    });

    it("derives safe filename from URL source with trailing slash", async () => {
      const { getPool } = await import("./db.js");
      const chunkRow = {
        chunk_id: "test-id:0",
        distance: 0.1,
        text: "hello world",
        source: "https://example.com/path/?q=1",
        chunk_index: 0,
        base_id: "test-base-id",
        doc_type: "pdf",
        repo_id: null,
        repo_url: null,
        path: null,
        lang: null,
        item_url: null,
        tier1_meta: {},
        tier2_meta: null,
        tier3_meta: null,
        doc_summary: null,
        doc_summary_short: null,
        doc_summary_medium: null,
        doc_summary_long: null,
        payload_checksum: null,
      };

      (getPool as any).mockReturnValueOnce({
        query: vi.fn(async () => ({ rows: [chunkRow] })),
      });
      (getPool as any).mockReturnValueOnce({
        query: vi.fn(async () => ({
          rows: [
            {
              raw_data: Buffer.from("PDF data"),
              raw_key: null,
              source: "https://example.com/path/?q=1",
              mime_type: "application/pdf",
            },
          ],
        })),
      });

      const app = buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/query/download-first",
        headers: { authorization: "Bearer test-token" },
        payload: { query: "hello world" },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers["content-disposition"]).toContain("filename=\"path.pdf\"");
      await app.close();
    });

    it("streams blob-store data when raw_key is present", async () => {
      const { getPool } = await import("./db.js");
      const { downloadRawBlobStream } = await import("./blob-store.js");
      const chunkRow = {
        chunk_id: "test-id:0",
        distance: 0.1,
        text: "hello world",
        source: "blob.doc",
        chunk_index: 0,
        base_id: "test-base-id",
        doc_type: "doc",
        repo_id: null,
        repo_url: null,
        path: null,
        lang: null,
        item_url: null,
        tier1_meta: {},
        tier2_meta: null,
        tier3_meta: null,
        doc_summary: null,
        doc_summary_short: null,
        doc_summary_medium: null,
        doc_summary_long: null,
        payload_checksum: null,
      };

      (downloadRawBlobStream as any).mockResolvedValueOnce({
        stream: Readable.from([Buffer.from("streamed-content")]),
        contentLength: 16,
        contentType: "application/octet-stream",
      });

      (getPool as any).mockReturnValueOnce({
        query: vi.fn(async () => ({ rows: [chunkRow] })),
      });
      (getPool as any).mockReturnValueOnce({
        query: vi.fn(async () => ({
          rows: [
            {
              raw_data: null,
              raw_key: "documents/test/raw.bin",
              source: "blob.doc",
              mime_type: "application/octet-stream",
            },
          ],
        })),
      });

      const app = buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/query/download-first",
        headers: { authorization: "Bearer test-token" },
        payload: { query: "hello world" },
      });

      expect(res.statusCode).toBe(200);
      expect(res.body).toBe("streamed-content");
      expect(downloadRawBlobStream).toHaveBeenCalledWith("documents/test/raw.bin");
      await app.close();
    });

    it("returns 404 when document has no raw data", async () => {
      const { getPool } = await import("./db.js");
      const chunkRow = {
        chunk_id: "test-id:0",
        distance: 0.1,
        text: "hello world",
        source: "doc.txt",
        chunk_index: 0,
        base_id: "test-base-id",
        doc_type: "text",
        repo_id: null,
        repo_url: null,
        path: null,
        lang: null,
        item_url: null,
        tier1_meta: {},
        tier2_meta: null,
        tier3_meta: null,
        doc_summary: null,
        doc_summary_short: null,
        doc_summary_medium: null,
        doc_summary_long: null,
        payload_checksum: null,
      };

      (getPool as any).mockReturnValueOnce({
        query: vi.fn(async () => ({ rows: [chunkRow] })),
      });
      (getPool as any).mockReturnValueOnce({
        query: vi.fn(async () => ({
          rows: [{ raw_data: null, raw_key: null, source: "doc.txt", mime_type: null }],
        })),
      });

      const app = buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/query/download-first",
        headers: { authorization: "Bearer test-token" },
        payload: { query: "hello world" },
      });

      expect(res.statusCode).toBe(404);
      await app.close();
    });
  });

  describe("POST /query/fulltext-first", () => {
    it("returns 404 when no results found", async () => {
      const { getPool } = await import("./db.js");
      (getPool as any).mockReturnValueOnce({
        query: vi.fn(async () => ({ rows: [] })),
      });

      const app = buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/query/fulltext-first",
        headers: {
          authorization: "Bearer test-token",
        },
        payload: { query: "nothing matches" },
      });

      expect(res.statusCode).toBe(404);
      await app.close();
    });

    it("returns concatenated text when document found", async () => {
      const { getPool } = await import("./db.js");
      const chunkRow = {
        chunk_id: "test-id:0",
        distance: 0.1,
        text: "hello world",
        source: "test.txt",
        chunk_index: 0,
        base_id: "test-base-id",
        doc_type: "text",
        repo_id: null,
        repo_url: null,
        path: null,
        lang: null,
        item_url: null,
        tier1_meta: {},
        tier2_meta: null,
        tier3_meta: null,
        doc_summary: null,
        doc_summary_short: null,
        doc_summary_medium: null,
        doc_summary_long: null,
        payload_checksum: null,
      };

      // First getPool() call: for the query service (vector search)
      (getPool as any).mockReturnValueOnce({
        query: vi.fn(async () => ({ rows: [chunkRow] })),
      });
      // Second getPool() call: for the fulltext chunks query in server route
      (getPool as any).mockReturnValueOnce({
        query: vi.fn(async () => ({
          rows: [
            { text: "chunk one", source: "test.txt" },
            { text: "chunk two", source: "test.txt" },
          ],
        })),
      });

      const app = buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/query/fulltext-first",
        headers: {
          authorization: "Bearer test-token",
        },
        payload: { query: "hello world" },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("text/plain");
      expect(res.body).toContain("chunk one");
      expect(res.body).toContain("chunk two");
      await app.close();
    });
  });
});
