import { describe, it, expect, vi, beforeEach } from "vitest";
import { ingest } from "./ingest.js";
import type { IngestRequest } from "./ingest.js";
import { getPool } from "../db.js";

// Mock the db module to avoid Postgres connection in tests
vi.mock("../db.js", () => ({
  query: vi.fn(async () => ({ rows: [] })),
  getPool: vi.fn(() => ({
    connect: vi.fn(async () => ({
      query: vi.fn(async () => ({ rows: [{ id: "test-doc-id" }] })),
      release: vi.fn(),
    })),
  })),
  runMigrations: vi.fn(),
  closePool: vi.fn(),
}));

// Mock embeddings module
vi.mock("../embeddings.js", () => ({
  embed: vi.fn(async (texts: string[]) =>
    texts.map(() => Array(768).fill(0.1))
  ),
}));

// Mock url-fetch and url-extract modules
vi.mock("./url-fetch.js", () => ({
  fetchUrls: vi.fn(async () => ({ results: new Map(), errors: [] })),
}));

vi.mock("./url-extract.js", () => ({
  extractContentAsync: vi.fn(async () => ({ text: "", strategy: "passthrough" })),
}));

describe("ingest service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function containsNullByte(value: unknown): boolean {
    if (typeof value === "string") {
      return value.includes("\u0000");
    }

    if (Array.isArray(value)) {
      return value.some((entry) => containsNullByte(entry));
    }

    if (value && typeof value === "object") {
      return Object.values(value).some((entry) => containsNullByte(entry));
    }

    return false;
  }

  it("ingests text items successfully", async () => {
    const request: IngestRequest = {
      collection: "test-col",
      items: [{ text: "hello world", source: "test.txt" }],
    };

    const result = await ingest(request, "test-col");

    expect(result.ok).toBe(true);
    expect(result.upserted).toBeGreaterThan(0);
  });

  it("uses default collection when none specified", async () => {
    const request: IngestRequest = {
      items: [{ text: "hello", source: "test.txt" }],
    };

    const result = await ingest(request);

    expect(result.ok).toBe(true);
  });

  it("returns the count of upserted chunks", async () => {
    const request: IngestRequest = {
      items: [
        { text: "item one", source: "a.txt" },
        { text: "item two", source: "b.txt" },
      ],
    };

    const result = await ingest(request);

    expect(result.ok).toBe(true);
    expect(result.upserted).toBe(2); // 2 items = 2 chunks
  });

  it("handles items with metadata", async () => {
    const request: IngestRequest = {
      items: [
        {
          text: "hello world",
          source: "test.txt",
          metadata: { lang: "en", author: "test" },
        },
      ],
    };

    const result = await ingest(request);

    expect(result.ok).toBe(true);
  });

  it("auto-derives source from URL when missing", async () => {
    const request: IngestRequest = {
      items: [
        {
          text: "hello",
          url: "https://example.com/path?query=1",
        },
      ],
    };

    const result = await ingest(request);

    expect(result.ok).toBe(true);
  });

  it("reports errors for items with missing text", async () => {
    const request: IngestRequest = {
      items: [
        { source: "test.txt" } as any, // Missing text
      ],
    };

    const result = await ingest(request);

    expect(result.ok).toBe(true);
    expect(result.errors).toBeDefined();
    expect(result.errors!.length).toBeGreaterThan(0);
  });

  it("reports errors for items with missing source", async () => {
    const request: IngestRequest = {
      items: [
        { text: "hello" } as any, // Missing source
      ],
    };

    const result = await ingest(request);

    expect(result.ok).toBe(true);
    expect(result.errors).toBeDefined();
    expect(result.errors!.length).toBeGreaterThan(0);
  });

  it("strips null bytes before writing document and chunk rows", async () => {
    let documentInsertParams: unknown[] | undefined;
    let chunkInsertParams: unknown[] | undefined;

    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes("INSERT INTO documents")) {
        documentInsertParams = params;
        return { rowCount: 1, rows: [{ id: "doc-1", base_id: "base-1" }] };
      }

      if (sql.includes("INSERT INTO chunks")) {
        chunkInsertParams = params;
        return { rowCount: 1, rows: [] };
      }

      if (sql.includes("SELECT identity_key")) {
        return { rowCount: 0, rows: [] };
      }

      return { rowCount: 1, rows: [] };
    });

    vi.mocked(getPool).mockReturnValue({
      connect: vi.fn(async () => ({
        query,
        release: vi.fn(),
      })),
    } as any);

    const request: IngestRequest = {
      items: [
        {
          text: "hello\u0000 world",
          source: "test\u0000.pdf",
          metadata: {
            path: "folder/with\u0000null.pdf",
            nested: {
              note: "a\u0000b",
            },
          },
        },
      ],
    };

    const result = await ingest(request, "test-col");

    expect(result.ok).toBe(true);
    expect(documentInsertParams).toBeDefined();
    expect(chunkInsertParams).toBeDefined();
    expect(containsNullByte(documentInsertParams)).toBe(false);
    expect(containsNullByte(chunkInsertParams)).toBe(false);
  });

  it("reports error for metadata exceeding maximum nesting depth", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("INSERT INTO documents")) {
        return { rowCount: 1, rows: [{ id: "doc-1", base_id: "base-1" }] };
      }

      if (sql.includes("SELECT identity_key")) {
        return { rowCount: 0, rows: [] };
      }

      return { rowCount: 1, rows: [] };
    });

    vi.mocked(getPool).mockReturnValue({
      connect: vi.fn(async () => ({
        query,
        release: vi.fn(),
      })),
    } as any);

    const deepMetadata: Record<string, unknown> = {};
    let cursor: Record<string, unknown> = deepMetadata;
    for (let i = 0; i < 70; i++) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
    }

    const request: IngestRequest = {
      items: [
        {
          text: "hello world",
          source: "test.txt",
          metadata: deepMetadata,
        },
      ],
    };

    const result = await ingest(request, "test-col");

    expect(result.ok).toBe(true);
    expect(result.upserted).toBe(0);
    expect(result.errors).toBeDefined();
    expect(result.errors!.length).toBe(1);
    expect(result.errors![0].reason).toContain("invalid_metadata");
    expect(result.errors![0].reason).toContain("nesting depth");
  });

  it("uses collection+identity conflict handling for overwrite upserts", async () => {
    let documentInsertSql = "";

    const query = vi.fn(async (sql: string) => {
      if (sql.includes("INSERT INTO documents")) {
        documentInsertSql = sql;
        return { rowCount: 1, rows: [{ id: "doc-1", base_id: "base-1" }] };
      }

      if (sql.includes("SELECT identity_key")) {
        return { rowCount: 0, rows: [] };
      }

      return { rowCount: 1, rows: [] };
    });

    vi.mocked(getPool).mockReturnValue({
      connect: vi.fn(async () => ({
        query,
        release: vi.fn(),
      })),
    } as any);

    await ingest(
      {
        overwrite: true,
        items: [{ text: "hello world", source: "test.txt" }],
      },
      "test-col"
    );

    expect(documentInsertSql).toContain("ON CONFLICT (collection, identity_key)");
  });

  it("uses generic conflict do nothing when overwrite is disabled", async () => {
    let documentInsertSql = "";

    const query = vi.fn(async (sql: string) => {
      if (sql.includes("INSERT INTO documents")) {
        documentInsertSql = sql;
        return { rowCount: 1, rows: [{ id: "doc-1", base_id: "base-1" }] };
      }

      if (sql.includes("SELECT identity_key")) {
        return { rowCount: 0, rows: [] };
      }

      return { rowCount: 1, rows: [] };
    });

    vi.mocked(getPool).mockReturnValue({
      connect: vi.fn(async () => ({
        query,
        release: vi.fn(),
      })),
    } as any);

    await ingest(
      {
        overwrite: false,
        items: [{ text: "hello world", source: "test.txt" }],
      },
      "test-col"
    );

    expect(documentInsertSql).toContain("ON CONFLICT");
    expect(documentInsertSql).toContain("DO NOTHING");
    expect(documentInsertSql).not.toContain("ON CONFLICT (collection, identity_key)");
  });

  it("reports error for circular reference in metadata and continues with other items", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("INSERT INTO documents")) {
        return { rowCount: 1, rows: [{ id: "doc-1", base_id: "base-1" }] };
      }

      if (sql.includes("SELECT identity_key")) {
        return { rowCount: 0, rows: [] };
      }

      return { rowCount: 1, rows: [] };
    });

    vi.mocked(getPool).mockReturnValue({
      connect: vi.fn(async () => ({
        query,
        release: vi.fn(),
      })),
    } as any);

    // Create circular reference
    const circularMeta: any = { foo: "bar" };
    circularMeta.self = circularMeta;

    const result = await ingest(
      {
        items: [
          { text: "bad item", source: "bad.txt", metadata: circularMeta },
          { text: "good item", source: "good.txt", metadata: { valid: "data" } },
        ],
      },
      "test-col"
    );

    expect(result.ok).toBe(true);
    expect(result.upserted).toBe(1); // Only the good item
    expect(result.errors).toBeDefined();
    expect(result.errors!.length).toBe(1);
    expect(result.errors![0].reason).toContain("invalid_metadata");
    expect(result.errors![0].reason).toContain("circular");
  });

  it("reports error for deeply nested metadata and continues with other items", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("INSERT INTO documents")) {
        return { rowCount: 1, rows: [{ id: "doc-1", base_id: "base-1" }] };
      }

      if (sql.includes("SELECT identity_key")) {
        return { rowCount: 0, rows: [] };
      }

      return { rowCount: 1, rows: [] };
    });

    vi.mocked(getPool).mockReturnValue({
      connect: vi.fn(async () => ({
        query,
        release: vi.fn(),
      })),
    } as any);

    // Create deeply nested metadata (exceeds MAX_METADATA_NESTING_DEPTH of 64)
    let deepMeta: any = { value: "end" };
    for (let i = 0; i < 70; i++) {
      deepMeta = { nested: deepMeta };
    }

    const result = await ingest(
      {
        items: [
          { text: "bad item", source: "bad.txt", metadata: deepMeta },
          { text: "good item", source: "good.txt", metadata: { valid: "data" } },
        ],
      },
      "test-col"
    );

    expect(result.ok).toBe(true);
    expect(result.upserted).toBe(1); // Only the good item
    expect(result.errors).toBeDefined();
    expect(result.errors!.length).toBe(1);
    expect(result.errors![0].reason).toContain("invalid_metadata");
    expect(result.errors![0].reason).toContain("nesting depth");
  });
});
