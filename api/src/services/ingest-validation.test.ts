import { describe, it, expect } from "vitest";
import { validateIngestRequest } from "./ingest-validation.js";
import type { IngestRequest } from "./ingest.js";

describe("validateIngestRequest", () => {
  it("should return null for valid request with text", () => {
    const request: IngestRequest = {
      items: [
        { text: "content", source: "test.txt" },
        { text: "more content", source: "test2.txt" },
      ],
    };
    const result = validateIngestRequest(request);
    expect(result).toBeNull();
  });

  it("should return null for valid request with url", () => {
    const request: IngestRequest = {
      items: [
        { url: "https://example.com" },
        { url: "https://example.org" },
      ],
    };
    const result = validateIngestRequest(request);
    expect(result).toBeNull();
  });

  it("should reject item without text or url", () => {
    const request: IngestRequest = {
      items: [
        { source: "test.txt" },
      ],
    };
    const result = validateIngestRequest(request);
    expect(result).not.toBeNull();
    expect(result?.error).toContain("must have either 'text' or 'url'");
  });

  it("should reject item without source when url is not provided", () => {
    const request: IngestRequest = {
      items: [
        { text: "content" },
      ],
    };
    const result = validateIngestRequest(request);
    expect(result).not.toBeNull();
    expect(result?.error).toContain("'source' is required when 'url' is not provided");
  });

  it("should reject request exceeding 50 URL limit", () => {
    const items = Array.from({ length: 51 }, (_, i) => ({
      url: `https://example.com/${i}`,
    }));
    const request: IngestRequest = { items };
    const result = validateIngestRequest(request);
    expect(result).not.toBeNull();
    expect(result?.error).toContain("maximum 50 URL items");
    expect(result?.error).toContain("51");
  });

  it("should accept exactly 50 URLs", () => {
    const items = Array.from({ length: 50 }, (_, i) => ({
      url: `https://example.com/${i}`,
    }));
    const request: IngestRequest = { items };
    const result = validateIngestRequest(request);
    expect(result).toBeNull();
  });

  it("should return null for request without items array", () => {
    const request = {} as IngestRequest;
    const result = validateIngestRequest(request);
    expect(result).toBeNull();
  });

  it("should return null for request with non-array items", () => {
    const request = { items: "not an array" } as unknown as IngestRequest;
    const result = validateIngestRequest(request);
    expect(result).toBeNull();
  });

  it("should handle mixed text and url items correctly", () => {
    const request: IngestRequest = {
      items: [
        { text: "content", source: "test.txt" },
        { url: "https://example.com" },
        { text: "more", source: "test2.txt" },
      ],
    };
    const result = validateIngestRequest(request);
    expect(result).toBeNull();
  });
});
