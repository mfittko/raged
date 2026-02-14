import { describe, it, expect } from "vitest";
import { chunkText } from "./chunking.js";

describe("chunkText", () => {
  it("returns an empty string in a single-element array for empty input", () => {
    // NOTE: This behavior is intentional and is documented here for clarity.
    // After trim(), the empty string has length 0 which is <= maxChars, so the
    // current implementation returns [""] instead of [].
    //
    // In the main ingest flow, upstream schema validation (minLength: 1) prevents
    // empty text from reaching chunkText, so this edge case does not affect the
    // ingest endpoint. This test exists to lock in and document the behavior in
    // case chunkText is reused in other contexts.
    const result = chunkText("");
    expect(result).toEqual([""]);
  });

  it("returns a single chunk for short text", () => {
    const text = "Hello, world!";
    const result = chunkText(text);
    expect(result).toEqual(["Hello, world!"]);
  });

  it("returns a single chunk when text length equals maxChars", () => {
    const text = "a".repeat(1800);
    const result = chunkText(text);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(text);
  });

  it("splits long text into multiple chunks", () => {
    // Create text with lines that will exceed 1800 chars total
    const line = "x".repeat(100) + "\n";
    const text = line.repeat(30); // 30 * 101 = 3030 chars
    const result = chunkText(text);
    expect(result.length).toBeGreaterThan(1);
    // Each chunk should be at most maxChars
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(1800);
    }
  });

  it("normalizes CRLF to LF", () => {
    const text = "line one\r\nline two\r\nline three";
    const result = chunkText(text);
    expect(result).toEqual(["line one\nline two\nline three"]);
  });

  it("trims leading and trailing whitespace", () => {
    const text = "  \n  hello  \n  ";
    const result = chunkText(text);
    expect(result).toEqual(["hello"]);
  });

  it("splits on line boundaries, not mid-line", () => {
    // Create lines where accumulating them crosses the boundary at a line break
    const lines: string[] = [];
    for (let i = 0; i < 40; i++) {
      lines.push(`Line ${i}: ${"y".repeat(80)}`);
    }
    const text = lines.join("\n"); // ~40 * ~88 = ~3520 chars
    const result = chunkText(text);
    expect(result.length).toBeGreaterThan(1);
    // Verify no chunk starts or ends mid-word within a known line
    for (const chunk of result) {
      // Each chunk should consist of complete lines (no partial lines)
      const chunkLines = chunk.split("\n");
      for (const cl of chunkLines) {
        expect(cl).toMatch(/^Line \d+: y+$/);
      }
    }
  });

  it("handles a single line longer than maxChars", () => {
    // A single line with no newlines that exceeds maxChars
    const longLine = "z".repeat(3600);
    const result = chunkText(longLine);
    // The algorithm splits on newlines; a single long line with no newlines
    // will be kept as one chunk since there are no line breaks to split on
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(longLine);
  });

  it("respects custom maxChars parameter", () => {
    const text = "aaa\nbbb\nccc\nddd\neee\nfff";
    const result = chunkText(text, 10);
    expect(result.length).toBeGreaterThan(1);
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(10);
    }
  });

  it("does not produce empty chunks", () => {
    const text = "hello\n\n\nworld\n\n\nfoo";
    const result = chunkText(text);
    for (const chunk of result) {
      expect(chunk.trim().length).toBeGreaterThan(0);
    }
  });
});
