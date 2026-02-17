import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ingest } from "./ingest.js";
import type { IngestRequest } from "./ingest.js";
import type { PoolClient } from "pg";
import { createHash } from "node:crypto";

const mockClient = {
  query: vi.fn(),
  release: vi.fn(),
} as unknown as PoolClient;

vi.mock("../db.js", () => ({
  getPool: vi.fn(() => ({
    connect: vi.fn(async () => mockClient),
  })),
}));

vi.mock("../embeddings.js", () => ({
  embed: vi.fn(async (texts: string[]) => texts.map(() => Array(3).fill(0.1))),
}));

vi.mock("./url-fetch.js", () => ({
  fetchUrls: vi.fn(),
}));

vi.mock("./url-extract.js", () => ({
  extractContentAsync: vi.fn(),
}));

vi.mock("../blob-store.js", () => ({
  shouldStoreRawBlob: vi.fn(() => false),
  uploadRawBlob: vi.fn(),
}));

import { fetchUrls } from "./url-fetch.js";
import { extractContentAsync } from "./url-extract.js";
import { shouldStoreRawBlob, uploadRawBlob } from "../blob-store.js";

const mockedFetchUrls = vi.mocked(fetchUrls);
const mockedExtractContentAsync = vi.mocked(extractContentAsync);
const mockedShouldStoreRawBlob = vi.mocked(shouldStoreRawBlob);
const mockedUploadRawBlob = vi.mocked(uploadRawBlob);

function setupClientForSingleDocument(baseId: string): void {
  mockClient.query = vi.fn(async (sql: string) => {
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
      return { rows: [] };
    }

    if (sql.includes("INSERT INTO documents")) {
      return { rows: [{ id: "doc-1", base_id: baseId }] };
    }

    return { rows: [] };
  }) as unknown as PoolClient["query"];
}

describe("ingest integration (Postgres)", () => {
  const originalEnrichmentEnabled = process.env.ENRICHMENT_ENABLED;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ENRICHMENT_ENABLED = "false";
    mockClient.release = vi.fn();
    mockedShouldStoreRawBlob.mockReturnValue(false);
  });

  afterEach(() => {
    if (originalEnrichmentEnabled === undefined) {
      delete process.env.ENRICHMENT_ENABLED;
    } else {
      process.env.ENRICHMENT_ENABLED = originalEnrichmentEnabled;
    }
  });

  it("ingests fetched URL content and reports fetched count", async () => {
    setupClientForSingleDocument("base-url-doc");

    mockedFetchUrls.mockResolvedValue({
      results: new Map([
        [
          "https://example.com/article",
          {
            url: "https://example.com/article",
            resolvedUrl: "https://example.com/article",
            contentType: "text/html; charset=utf-8",
            status: 200,
            body: Buffer.from("<html><body><article>Hello URL world</article></body></html>"),
            fetchedAt: "2026-02-16T00:00:00Z",
          },
        ],
      ]),
      errors: [],
    });

    mockedExtractContentAsync.mockResolvedValue({
      text: "Hello URL world",
      title: "Hello Article",
      strategy: "readability",
      contentType: "text/html",
    });

    const request: IngestRequest = {
      items: [{ url: "https://example.com/article", docType: "article" }],
    };

    const result = await ingest(request, "docs");

    expect(result.ok).toBe(true);
    expect(result.upserted).toBeGreaterThan(0);
    expect(result.fetched).toBe(1);
    expect(result.errors).toBeUndefined();
    expect(mockClient.release).toHaveBeenCalled();
  });

  it("returns unsupported content as ingestion errors", async () => {
    mockedFetchUrls.mockResolvedValue({
      results: new Map([
        [
          "https://example.com/image.png",
          {
            url: "https://example.com/image.png",
            resolvedUrl: "https://example.com/image.png",
            contentType: "image/png",
            status: 200,
            body: Buffer.from("not-text"),
            fetchedAt: "2026-02-16T00:00:00Z",
          },
        ],
      ]),
      errors: [],
    });

    mockedExtractContentAsync.mockResolvedValue({
      text: null,
      strategy: "metadata-only",
      contentType: "image/png",
    });

    const result = await ingest({ items: [{ url: "https://example.com/image.png" }] }, "docs");

    expect(result.ok).toBe(true);
    expect(result.upserted).toBe(0);
    expect(result.errors).toBeDefined();
    expect(result.errors?.[0]?.reason).toContain("unsupported_content_type");
  });

  it("returns no_extractable_text for supported content types with empty extraction", async () => {
    mockedFetchUrls.mockResolvedValue({
      results: new Map([
        [
          "https://example.com/empty",
          {
            url: "https://example.com/empty",
            resolvedUrl: "https://example.com/empty",
            contentType: "text/html; charset=UTF-8",
            status: 200,
            body: Buffer.from("<html><body></body></html>"),
            fetchedAt: "2026-02-16T00:00:00Z",
          },
        ],
      ]),
      errors: [],
    });

    mockedExtractContentAsync.mockResolvedValue({
      text: null,
      strategy: "readability",
      contentType: "text/html",
    });

    const result = await ingest({ items: [{ url: "https://example.com/empty" }] }, "docs");

    expect(result.ok).toBe(true);
    expect(result.upserted).toBe(0);
    expect(result.errors).toBeDefined();
    expect(result.errors?.[0]?.reason).toContain("no_extractable_text");
    expect(result.errors?.[0]?.reason).toContain("text/html; charset=UTF-8");
  });

  it("preserves existing base_id on identity conflict and uses returned base_id for tasks", async () => {
    process.env.ENRICHMENT_ENABLED = "true";

    mockClient.query = vi.fn(async (sql: string) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [] };
      }

      if (sql.includes("INSERT INTO documents")) {
        return { rows: [{ id: "doc-existing", base_id: "existing-base-id" }] };
      }

      return { rows: [] };
    }) as unknown as PoolClient["query"];

    const result = await ingest(
      {
        enrich: true,
        items: [{ id: "new-base-id", source: "https://example.com/stable", text: "same identity" }],
      },
      "docs",
    );

    expect(result.ok).toBe(true);
    expect(result.enrichment?.enqueued).toBeGreaterThan(0);

    const enqueueCall = vi
      .mocked(mockClient.query)
      .mock.calls.find(([sql]) => typeof sql === "string" && sql.includes("INSERT INTO task_queue"));

    expect(enqueueCall).toBeDefined();
    const params = enqueueCall![1] as unknown[];
    const payload = JSON.parse(String(params[2])) as { baseId: string; chunkId: string };
    expect(payload.baseId).toBe("existing-base-id");
    expect(payload.chunkId.startsWith("existing-base-id:")).toBe(true);
  });

  it("writes filterable metadata fields to documents and chunks", async () => {
    setupClientForSingleDocument("base-filter-doc");

    const result = await ingest(
      {
        items: [
          {
            source: "repo/src/auth.ts",
            text: "export const hello = true;",
            docType: "code",
            metadata: {
              repoId: "raged",
              repoUrl: "https://github.com/mfittko/RAGed",
              path: "src/auth.ts",
              lang: "ts",
            },
          },
        ],
      },
      "docs",
    );

    expect(result.ok).toBe(true);

    const docInsertCall = vi
      .mocked(mockClient.query)
      .mock.calls.find(([sql]) => typeof sql === "string" && sql.includes("INSERT INTO documents"));
    expect(docInsertCall).toBeDefined();
    const docParams = docInsertCall![1] as unknown[];
    expect(docParams).toContain("raged");
    expect(docParams).toContain("https://github.com/mfittko/RAGed");
    expect(docParams).toContain("src/auth.ts");
    expect(docParams).toContain("ts");

    const chunkInsertCall = vi
      .mocked(mockClient.query)
      .mock.calls.find(([sql]) => typeof sql === "string" && sql.includes("INSERT INTO chunks"));
    expect(chunkInsertCall).toBeDefined();
    const chunkParams = chunkInsertCall![1] as unknown[];
    expect(chunkParams).toContain("raged");
    expect(chunkParams).toContain("src/auth.ts");
    expect(chunkParams).toContain("ts");
    expect(chunkParams).toContain("code");
  });

  it("stores oversized raw content in blob storage and persists raw references", async () => {
    setupClientForSingleDocument("base-blob-doc");

    mockedShouldStoreRawBlob.mockReturnValue(true);
    mockedUploadRawBlob.mockResolvedValue({
      key: "documents/doc-1/raw-abcd1234.txt",
      bytes: 1_424_243,
      mimeType: "application/pdf",
    });

    const rawBytes = Buffer.from("%PDF-1.7\nvery-large-binary-placeholder\n", "utf8");

    const result = await ingest(
      {
        items: [
          {
            source: "tmp/sample.pdf",
            text: "extracted pdf text",
            docType: "pdf",
            rawData: rawBytes.toString("base64"),
            rawMimeType: "application/pdf",
            metadata: { sizeBytes: 1_424_243, contentType: "application/pdf" },
          },
        ],
      },
      "docs",
    );

    expect(result.ok).toBe(true);
    expect(mockedUploadRawBlob).toHaveBeenCalledOnce();
    expect(mockedUploadRawBlob).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "tmp/sample.pdf",
        mimeType: "application/pdf",
        body: expect.any(Buffer),
      }),
    );
    const uploadArg = mockedUploadRawBlob.mock.calls[0]?.[0] as { body: Buffer };
    expect(uploadArg.body.equals(rawBytes)).toBe(true);

    const updateCall = vi
      .mocked(mockClient.query)
      .mock.calls.find(([sql]) =>
        typeof sql === "string" &&
        sql.includes("UPDATE documents") &&
        sql.includes("raw_key"),
      );

    expect(updateCall).toBeDefined();
    expect(updateCall?.[1]).toEqual([
      "doc-1",
      "documents/doc-1/raw-abcd1234.txt",
      1_424_243,
      "application/pdf",
      expect.any(String),
    ]);
  });

  it("stores exact raw payload in raw_data when below blob threshold", async () => {
    setupClientForSingleDocument("base-raw-doc");

    mockedShouldStoreRawBlob.mockReturnValue(false);

    const rawBytes = Buffer.from("%PDF-1.7\nraw-binary-payload\n", "utf8");
    const expectedChecksum = createHash("sha256").update(rawBytes).digest("hex");

    const result = await ingest(
      {
        items: [
          {
            source: "tmp/small.pdf",
            text: "derived extracted text",
            docType: "pdf",
            rawData: rawBytes.toString("base64"),
            rawMimeType: "application/pdf",
            metadata: { sizeBytes: rawBytes.length, contentType: "application/pdf" },
          },
        ],
      },
      "docs",
    );

    expect(result.ok).toBe(true);
    expect(mockedUploadRawBlob).not.toHaveBeenCalled();

    const docInsertCall = vi
      .mocked(mockClient.query)
      .mock.calls.find(([sql]) => typeof sql === "string" && sql.includes("INSERT INTO documents"));

    expect(docInsertCall).toBeDefined();
    const docParams = docInsertCall![1] as unknown[];
    expect(docParams[11]).toBe(expectedChecksum);
    expect(docParams[13]).toBe(rawBytes.length);
    expect(docParams[14]).toBe("application/pdf");
    expect(Buffer.isBuffer(docParams[16])).toBe(true);
    expect((docParams[16] as Buffer).equals(rawBytes)).toBe(true);
  });

  it("skips existing identity when overwrite is not enabled", async () => {
    mockClient.query = vi.fn(async (sql: string) => {
      if (sql.includes("SELECT identity_key, payload_checksum")) {
        return {
          rows: [{ identity_key: "repo/src/auth.ts", payload_checksum: "existing-checksum" }],
        };
      }

      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [] };
      }

      if (sql.includes("INSERT INTO documents")) {
        return { rows: [{ id: "doc-1", base_id: "base-skip-doc" }] };
      }

      return { rows: [] };
    }) as unknown as PoolClient["query"];

    const result = await ingest(
      {
        items: [
          {
            source: "repo/src/auth.ts",
            text: "export const hello = true;",
            docType: "code",
          },
        ],
      },
      "docs",
    );

    expect(result.ok).toBe(true);
    expect(result.upserted).toBe(0);
    expect(result.skipped).toBe(1);

    const docInsertCall = vi
      .mocked(mockClient.query)
      .mock.calls.find(([sql]) => typeof sql === "string" && sql.includes("INSERT INTO documents"));

    expect(docInsertCall).toBeUndefined();
  });
});
