import { describe, it, expect } from "vitest";
import { extractSlack } from "./slack.js";
import type { IngestItem } from "../doctype.js";

describe("extractSlack", () => {
  it("should extract from JSON message", () => {
    const item: IngestItem = {
      text: JSON.stringify({
        channel: "general",
        thread_ts: "1234.5678",
        user: "U123",
        ts: "1234.5678",
      }),
      source: "export.json",
    };
    const result = extractSlack(item);
    expect(result.channel).toBe("general");
    expect(result.threadId).toBe("1234.5678");
    expect(result.timestamp).toBe("1234.5678");
    expect(result.participants).toContain("U123");
  });

  it("should extract from Slack export with messages array", () => {
    const item: IngestItem = {
      text: JSON.stringify({
        messages: [
          { user: "U123", ts: "1234.5678" },
          { user: "U456", ts: "1234.5679" },
        ],
      }),
      source: "export.json",
    };
    const result = extractSlack(item);
    expect(result.participants).toContain("U123");
    expect(result.participants).toContain("U456");
    expect(result.timestamp).toBe("1234.5678");
  });

  it("should fallback to metadata when JSON parsing fails", () => {
    const item: IngestItem = {
      text: "Not valid JSON",
      source: "export.txt",
      metadata: {
        channel: "general",
        threadId: "thread-123",
      },
    };
    const result = extractSlack(item);
    expect(result.channel).toBe("general");
    expect(result.threadId).toBe("thread-123");
  });

  it("should handle no text with metadata fallback", () => {
    const item: IngestItem = {
      source: "export.json",
      metadata: {
        channel: "random",
      },
    };
    const result = extractSlack(item);
    expect(result.channel).toBe("random");
  });
});
