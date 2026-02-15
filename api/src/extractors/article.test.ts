import { describe, it, expect } from "vitest";
import { extractArticle } from "./article.js";
import type { IngestItem } from "../doctype.js";

describe("extractArticle", () => {
  it("should extract from Open Graph tags", () => {
    const item: IngestItem = {
      text: '<meta property="og:title" content="My Article"/><meta property="og:author" content="John Doe"/>',
      source: "article.html",
    };
    const result = extractArticle(item);
    expect(result.title).toBe("My Article");
    expect(result.author).toBe("John Doe");
  });

  it("should extract from markdown frontmatter", () => {
    const item: IngestItem = {
      text: "---\ntitle: My Post\nauthor: Jane Doe\ndate: 2024-01-01\n---\n\n# Content",
      source: "post.md",
    };
    const result = extractArticle(item);
    expect(result.title).toBe("My Post");
    expect(result.author).toBe("Jane Doe");
    expect(result.publishDate).toBe("2024-01-01");
  });

  it("should use source as URL when it's a URL", () => {
    const item: IngestItem = {
      text: "Content",
      source: "https://example.com/article",
    };
    const result = extractArticle(item);
    expect(result.url).toBe("https://example.com/article");
  });

  it("should fallback to HTML title tag", () => {
    const item: IngestItem = {
      text: "<html><head><title>Article Title</title></head><body>Content</body></html>",
      source: "page.html",
    };
    const result = extractArticle(item);
    expect(result.title).toBe("Article Title");
  });

  it("should return empty object when no text provided", () => {
    const item: IngestItem = {
      source: "article.html",
    };
    const result = extractArticle(item);
    expect(result).toEqual({});
  });
});
