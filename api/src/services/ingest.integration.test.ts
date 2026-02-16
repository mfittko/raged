import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ingest } from "./ingest.js";
import type { IngestRequest } from "./ingest.js";
import type { PoolClient } from "pg";

const mockClient = {
  query: vi.fn(),
  release: vi.fn(),
} as unknown as PoolClient;

vi.mock("../db.js", () => ({
  getPool: vi.fn(() => ({
    connect: vi.fn(async () => mockClient),
  })),
}));

vi.mock("../ollama.js", () => ({
  embed: vi.fn(async (texts: string[]) => texts.map(() => Array(3).fill(0.1))),
}));

vi.mock("./url-fetch.js", () => ({
  fetchUrls: vi.fn(),
}));

vi.mock("./url-extract.js", () => ({
  extractContentAsync: vi.fn(),
}));

import { fetchUrls } from "./url-fetch.js";
import { extractContentAsync } from "./url-extract.js";

const mockedFetchUrls = vi.mocked(fetchUrls);
const mockedExtractContentAsync = vi.mocked(extractContentAsync);

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
});
