import { describe, it, expect, vi } from "vitest";
import { extractContent, extractContentAsync } from "./url-extract.js";

describe("Content extraction service", () => {
  describe("HTML extraction", () => {
    it("extracts article text from HTML via Readability", () => {
      const html = `
        <!DOCTYPE html>
        <html>
          <head><title>Test Article</title></head>
          <body>
            <article>
              <h1>Main Article Title</h1>
              <p>This is the main content of the article.</p>
              <p>This is another paragraph with useful information.</p>
            </article>
            <nav>Navigation menu - should be ignored</nav>
            <footer>Footer - should be ignored</footer>
          </body>
        </html>
      `;
      
      const result = extractContent(Buffer.from(html, "utf-8"), "text/html");
      
      expect(result.strategy).toBe("readability");
      expect(result.contentType).toBe("text/html");
      expect(result.text).toBeTruthy();
      expect(result.text).toContain("Main Article Title");
      expect(result.text).toContain("main content of the article");
      expect(result.title).toBe("Test Article");
    });

    it("handles HTML with charset in content-type", () => {
      const html = `<html><body><h1>Test</h1><p>Content</p></body></html>`;
      
      const result = extractContent(Buffer.from(html, "utf-8"), "text/html; charset=utf-8");
      
      expect(result.strategy).toBe("readability");
      expect(result.contentType).toBe("text/html");
      expect(result.text).toBeTruthy();
    });

    it("returns fallback for malformed HTML", () => {
      const html = `<invalid>Not really HTML`;
      
      const result = extractContent(Buffer.from(html, "utf-8"), "text/html");
      
      expect(result.strategy).toBe("readability");
      expect(result.contentType).toBe("text/html");
      // Should still return something (fallback to body text)
    });

    it("uses turndown/plaintext strategy when Readability returns null", async () => {
      vi.resetModules();
      vi.doMock("@mozilla/readability", () => ({
        Readability: class {
          parse() {
            return null;
          }
        },
      }));

      try {
        const { extractContent: extractWithMock } = await import("./url-extract.js");
        const result = extractWithMock(
          Buffer.from("<html><body><p>Fallback text</p></body></html>", "utf-8"),
          "text/html"
        );

        expect(["turndown", "plaintext"]).toContain(result.strategy);
        expect(result.text).toContain("Fallback text");
      } finally {
        vi.doUnmock("@mozilla/readability");
        vi.resetModules();
      }
    });
  });

  describe("plain text passthrough", () => {
    it("passes through plain text unchanged", () => {
      const text = "This is plain text content.\nWith multiple lines.\n";
      
      const result = extractContent(Buffer.from(text, "utf-8"), "text/plain");
      
      expect(result.strategy).toBe("passthrough");
      expect(result.contentType).toBe("text/plain");
      expect(result.text).toBe(text);
    });

    it("handles plain text with charset", () => {
      const text = "Plain text content";
      
      const result = extractContent(Buffer.from(text, "utf-8"), "text/plain; charset=utf-8");
      
      expect(result.strategy).toBe("passthrough");
      expect(result.contentType).toBe("text/plain");
      expect(result.text).toBe(text);
    });
  });

  describe("markdown passthrough", () => {
    it("passes through markdown unchanged", () => {
      const markdown = `# Heading\n\nThis is **bold** text.\n\n- List item 1\n- List item 2\n`;
      
      const result = extractContent(Buffer.from(markdown, "utf-8"), "text/markdown");
      
      expect(result.strategy).toBe("passthrough");
      expect(result.contentType).toBe("text/markdown");
      expect(result.text).toBe(markdown);
    });
  });

  describe("JSON handling", () => {
    it("pretty-prints valid JSON", () => {
      const json = '{"key":"value","nested":{"a":1,"b":2}}';
      
      const result = extractContent(Buffer.from(json, "utf-8"), "application/json");
      
      expect(result.strategy).toBe("passthrough");
      expect(result.contentType).toBe("application/json");
      expect(result.text).toContain('"key": "value"');
      expect(result.text).toContain('"nested"');
      expect(result.text).toContain('"a": 1');
    });

    it("handles invalid JSON gracefully", () => {
      const invalidJson = '{not valid json';
      
      const result = extractContent(Buffer.from(invalidJson, "utf-8"), "application/json");
      
      expect(result.strategy).toBe("passthrough");
      expect(result.contentType).toBe("application/json");
      expect(result.text).toBe(invalidJson);
    });
  });

  describe("PDF extraction", () => {
    it("returns null for PDF in sync version", () => {
      // Create a minimal PDF buffer (won't be valid, but that's ok for this test)
      const pdfBuffer = Buffer.from("%PDF-1.4\n");
      
      const result = extractContent(pdfBuffer, "application/pdf");
      
      expect(result.strategy).toBe("pdf-parse");
      expect(result.contentType).toBe("application/pdf");
      expect(result.text).toBeNull();
    });

    it("handles PDF extraction in async version", async () => {
      // For a real PDF, we'd need a valid PDF buffer
      // For now, test that it handles invalid PDF gracefully
      const invalidPdf = Buffer.from("not a real pdf");
      
      const result = await extractContentAsync(invalidPdf, "application/pdf");
      
      expect(result.strategy).toBe("pdf-parse");
      expect(result.contentType).toBe("application/pdf");
      expect(result.text).toBeNull(); // Should fail gracefully
    });
  });

  describe("unsupported content types", () => {
    it("returns null text for unsupported content type", () => {
      const buffer = Buffer.from("binary data");
      
      const result = extractContent(buffer, "application/octet-stream");
      
      expect(result.strategy).toBe("metadata-only");
      expect(result.contentType).toBe("application/octet-stream");
      expect(result.text).toBeNull();
    });

    it("returns null text for image types", () => {
      const buffer = Buffer.from("fake image data");
      
      const result = extractContent(buffer, "image/png");
      
      expect(result.strategy).toBe("metadata-only");
      expect(result.contentType).toBe("image/png");
      expect(result.text).toBeNull();
    });

    it("returns null text for video types", () => {
      const buffer = Buffer.from("fake video data");
      
      const result = extractContent(buffer, "video/mp4");
      
      expect(result.strategy).toBe("metadata-only");
      expect(result.contentType).toBe("video/mp4");
      expect(result.text).toBeNull();
    });
  });

  describe("content-type normalization", () => {
    it("normalizes content-type to lowercase", () => {
      const text = "Test content";
      
      const result = extractContent(Buffer.from(text, "utf-8"), "TEXT/PLAIN");
      
      expect(result.contentType).toBe("text/plain");
    });

    it("strips parameters from content-type", () => {
      const text = "Test content";
      
      const result = extractContent(Buffer.from(text, "utf-8"), "text/plain; charset=iso-8859-1; boundary=something");
      
      expect(result.contentType).toBe("text/plain");
    });
  });
});
