import { describe, it, expect } from "vitest";
import { extractPdf } from "./pdf.js";
import type { IngestItem } from "../doctype.js";

describe("extractPdf", () => {
  it("should extract from metadata", () => {
    const item: IngestItem = {
      text: "PDF content",
      source: "document.pdf",
      metadata: {
        title: "My Document",
        author: "John Doe",
        pageCount: 10,
        createdDate: "2024-01-01",
      },
    };
    const result = extractPdf(item);
    expect(result.title).toBe("My Document");
    expect(result.author).toBe("John Doe");
    expect(result.pageCount).toBe(10);
    expect(result.createdDate).toBe("2024-01-01");
  });

  it("should handle partial metadata", () => {
    const item: IngestItem = {
      text: "PDF content",
      source: "document.pdf",
      metadata: {
        title: "My Document",
      },
    };
    const result = extractPdf(item);
    expect(result.title).toBe("My Document");
    expect(result.author).toBeUndefined();
    expect(result.pageCount).toBeUndefined();
  });

  it("should return empty object when no metadata provided", () => {
    const item: IngestItem = {
      text: "PDF content",
      source: "document.pdf",
    };
    const result = extractPdf(item);
    expect(result).toEqual({});
  });
});
