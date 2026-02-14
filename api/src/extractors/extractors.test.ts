import { describe, it, expect } from "vitest";
import { extractCode } from "./code.js";
import { extractEmail } from "./email.js";
import { extractSlack } from "./slack.js";
import { extractMeeting } from "./meeting.js";
import { extractArticle } from "./article.js";
import { extractPdf } from "./pdf.js";
import { extractImage } from "./image.js";
import type { IngestItem } from "../doctype.js";

describe("extractCode", () => {
  it("should extract language from file extension", () => {
    const item: IngestItem = {
      text: "function test() {}",
      source: "test.ts",
    };
    const result = extractCode(item);
    expect(result.lang).toBe("typescript");
  });

  it("should extract function names", () => {
    const item: IngestItem = {
      text: "function hello() {}\nfunction world() {}",
      source: "test.js",
    };
    const result = extractCode(item);
    expect(result.functions).toEqual(["hello", "world"]);
  });

  it("should extract class names", () => {
    const item: IngestItem = {
      text: "class MyClass {}\nclass AnotherClass {}",
      source: "test.ts",
    };
    const result = extractCode(item);
    expect(result.classes).toEqual(["MyClass", "AnotherClass"]);
  });

  it("should extract imports", () => {
    const item: IngestItem = {
      text: 'import { foo } from "bar";\nimport "baz";',
      source: "test.ts",
    };
    const result = extractCode(item);
    expect(result.imports).toContain("bar");
    expect(result.imports).toContain("baz");
  });

  it("should extract exports", () => {
    const item: IngestItem = {
      text: "export const foo = 1;\nexport function bar() {}",
      source: "test.ts",
    };
    const result = extractCode(item);
    expect(result.exports).toContain("foo");
    expect(result.exports).toContain("bar");
  });

  it("should limit function names to 100 items", () => {
    // Generate 150 function declarations
    const functions = Array.from({ length: 150 }, (_, i) => `function func${i}() {}`).join("\n");
    const item: IngestItem = {
      text: functions,
      source: "test.js",
    };
    const result = extractCode(item);
    expect(result.functions).toBeDefined();
    expect(result.functions!.length).toBeLessThanOrEqual(100);
  });

  it("should limit class names to 100 items", () => {
    // Generate 150 class declarations
    const classes = Array.from({ length: 150 }, (_, i) => `class Class${i} {}`).join("\n");
    const item: IngestItem = {
      text: classes,
      source: "test.ts",
    };
    const result = extractCode(item);
    expect(result.classes).toBeDefined();
    expect(result.classes!.length).toBeLessThanOrEqual(100);
  });
});

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
});

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
});

describe("extractMeeting", () => {
  it("should extract meeting metadata", () => {
    const item: IngestItem = {
      text: "Meeting Date: 2024-01-01\nDuration: 1hr\nPlatform: Zoom\nAttendees: Alice, Bob, Charlie\n\nNotes...",
      source: "standup.txt",
    };
    const result = extractMeeting(item);
    expect(result.date).toBe("2024-01-01");
    expect(result.duration).toBe("1hr");
    expect(result.platform).toBe("Zoom");
    expect(result.participants).toEqual(["Alice", "Bob", "Charlie"]);
  });
});

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
});

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
});

describe("extractImage", () => {
  it("should extract from metadata", () => {
    const item: IngestItem = {
      text: "Image description",
      source: "photo.jpg",
      metadata: {
        mimeType: "image/jpeg",
        width: 1920,
        height: 1080,
      },
    };
    const result = extractImage(item);
    expect(result.mimeType).toBe("image/jpeg");
    expect(result.dimensions).toEqual({ width: 1920, height: 1080 });
  });
});
