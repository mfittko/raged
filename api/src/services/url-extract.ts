import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import { PDFParse } from "pdf-parse";
import TurndownService from "turndown";

export interface ExtractionResult {
  text: string | null;        // null for unsupported types
  title?: string;             // from HTML/PDF metadata
  strategy: "readability" | "passthrough" | "pdf-parse" | "metadata-only";
  contentType: string;
}

const turndown = new TurndownService({
  headingStyle: "atx",
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
});

function toMarkdown(html: string | null | undefined): string {
  if (!html) {
    return "";
  }

  try {
    return turndown.turndown(html).trim();
  } catch {
    return "";
  }
}

/**
 * Extraction strategies:
 * - readability: Uses Mozilla's Readability library to extract article content from HTML
 * - passthrough: Returns the content as-is (for text/plain, text/markdown, application/json)
 * - pdf-parse: Extracts text from PDF documents
 * - metadata-only: Used for unsupported formats (returns null text)
 */

function normalizeContentType(contentType: string): string {
  // Handle edge cases
  if (!contentType || typeof contentType !== "string") {
    return "application/octet-stream";
  }
  
  // Extract base content type (strip charset, etc.)
  return contentType.split(";")[0].trim().toLowerCase();
}

export function extractContent(body: Buffer, contentType: string): ExtractionResult {
  const normalized = normalizeContentType(contentType);
  
  // HTML extraction using Readability
  if (normalized === "text/html") {
    try {
      const dom = new JSDOM(body.toString("utf-8"), { url: "https://example.com" });
      const reader = new Readability(dom.window.document);
      const article = reader.parse();
      
      if (article) {
        const markdown = toMarkdown(article.content);
        const fallbackText = article.textContent?.trim() || null;

        return {
          text: markdown || fallbackText,
          title: article.title ?? undefined,
          strategy: "readability",
          contentType: normalized,
        };
      }
      
      // Fallback if Readability fails
      const bodyMarkdown = toMarkdown(dom.window.document.body?.innerHTML);
      const bodyText = dom.window.document.body?.textContent?.trim() || null;

      return {
        text: bodyMarkdown || bodyText,
        strategy: "readability",
        contentType: normalized,
      };
    } catch (error) {
      // If parsing fails, return null
      return {
        text: null,
        strategy: "readability",
        contentType: normalized,
      };
    }
  }
  
  // Plain text passthrough
  if (normalized === "text/plain") {
    return {
      text: body.toString("utf-8"),
      strategy: "passthrough",
      contentType: normalized,
    };
  }
  
  // Markdown passthrough
  if (normalized === "text/markdown") {
    return {
      text: body.toString("utf-8"),
      strategy: "passthrough",
      contentType: normalized,
    };
  }
  
  // JSON passthrough (pretty-print)
  if (normalized === "application/json") {
    try {
      const parsed = JSON.parse(body.toString("utf-8"));
      return {
        text: JSON.stringify(parsed, null, 2),
        strategy: "passthrough",
        contentType: normalized,
      };
    } catch {
      // If JSON parsing fails, return raw text
      return {
        text: body.toString("utf-8"),
        strategy: "passthrough",
        contentType: normalized,
      };
    }
  }
  
  // PDF extraction requires async - use extractContentAsync instead
  if (normalized === "application/pdf") {
    return {
      text: null,
      strategy: "pdf-parse",
      contentType: normalized,
    };
  }
  
  // Unsupported content type - metadata only
  return {
    text: null,
    strategy: "metadata-only",
    contentType: normalized,
  };
}

// Async version for PDF extraction
export async function extractContentAsync(body: Buffer, contentType: string): Promise<ExtractionResult> {
  const normalized = normalizeContentType(contentType);
  
  // PDF extraction (async)
  if (normalized === "application/pdf") {
    try {
      const parser = new PDFParse({ data: body });
      const result = await parser.getText();
      return {
        text: result.text,
        title: undefined, // Title can be extracted from getInfo() if needed
        strategy: "pdf-parse",
        contentType: normalized,
      };
    } catch {
      return {
        text: null,
        strategy: "pdf-parse",
        contentType: normalized,
      };
    }
  }
  
  // For all other types, use the sync version
  return extractContent(body, contentType);
}
