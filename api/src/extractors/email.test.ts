import { describe, it, expect } from "vitest";
import { extractEmail } from "./email.js";
import type { IngestItem } from "../doctype.js";

describe("extractEmail", () => {
  it("should extract email headers", () => {
    const item: IngestItem = {
      text: "From: sender@example.com\nTo: recipient@example.com\nSubject: Test\nDate: 2024-01-01\n\nBody",
      source: "message.eml",
    };
    const result = extractEmail(item);
    expect(result.from).toBe("sender@example.com");
    expect(result.to).toEqual(["recipient@example.com"]);
    expect(result.subject).toBe("Test");
    expect(result.date).toBe("2024-01-01");
  });

  it("should handle multiple recipients", () => {
    const item: IngestItem = {
      text: "To: user1@example.com, user2@example.com\nCc: cc@example.com\n\n",
      source: "message.eml",
    };
    const result = extractEmail(item);
    expect(result.to).toEqual(["user1@example.com", "user2@example.com"]);
    expect(result.cc).toEqual(["cc@example.com"]);
  });

  it("should extract Message-ID and threading headers", () => {
    const item: IngestItem = {
      text: "Message-ID: <abc@example.com>\nIn-Reply-To: <xyz@example.com>\nReferences: <ref1@example.com> <ref2@example.com>\n\n",
      source: "message.eml",
    };
    const result = extractEmail(item);
    expect(result.messageId).toBe("<abc@example.com>");
    expect(result.inReplyTo).toBe("<xyz@example.com>");
    expect(result.references).toEqual(["<ref1@example.com>", "<ref2@example.com>"]);
  });

  it("should return empty object when no text provided", () => {
    const item: IngestItem = {
      source: "message.eml",
    };
    const result = extractEmail(item);
    expect(result).toEqual({});
  });
});
