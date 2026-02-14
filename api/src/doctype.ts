export type DocType =
  | "code"
  | "slack"
  | "email"
  | "meeting"
  | "pdf"
  | "image"
  | "article"
  | "text";

export interface IngestItem {
  id?: string;
  text: string;
  source: string;
  docType?: DocType;
  metadata?: Record<string, unknown>;
}

const CODE_EXTENSIONS = new Set([
  ".js",
  ".ts",
  ".jsx",
  ".tsx",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".c",
  ".cpp",
  ".h",
  ".hpp",
  ".cs",
  ".rb",
  ".php",
  ".swift",
  ".kt",
  ".scala",
  ".clj",
  ".sh",
  ".bash",
  ".sql",
]);

const IMAGE_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".svg",
  ".bmp",
  ".tiff",
]);

const ARTICLE_EXTENSIONS = new Set([".md", ".html", ".htm", ".txt"]);

export function detectDocType(item: IngestItem): DocType {
  // 1. Explicit docType
  if (item.docType) {
    return item.docType;
  }

  // 2. Metadata hints
  if (item.metadata) {
    // Slack: has channel or threadId
    if (item.metadata.channel || item.metadata.threadId) {
      return "slack";
    }
    // Email: has from and subject
    if (item.metadata.from && item.metadata.subject) {
      return "email";
    }
  }

  // 3. Source URL patterns
  const sourceLower = item.source.toLowerCase();
  // Use URL parsing for more secure host detection
  try {
    const url = new URL(sourceLower);
    const hostname = url.hostname;
    if (hostname === "github.com" || hostname.endsWith(".github.com") ||
        hostname === "gitlab.com" || hostname.endsWith(".gitlab.com")) {
      return "code";
    }
    if (hostname === "slack.com" || hostname.endsWith(".slack.com")) {
      return "slack";
    }
  } catch {
    // Not a valid URL, fall through to other detection methods
  }

  // 4. Content sniffing
  const contentStart = item.text.substring(0, 500);

  // Email: RFC 2822 headers
  if (
    /^(From|To|Subject|Date|Message-ID):\s+/im.test(contentStart) &&
    contentStart.includes("\n")
  ) {
    return "email";
  }

  // Slack: JSON with messages array
  // Guard against parsing large JSON payloads
  const MAX_JSON_SIZE = 100_000; // 100KB
  if (contentStart.trimStart().startsWith("{") && item.text.length <= MAX_JSON_SIZE) {
    try {
      const parsed = JSON.parse(item.text);
      if (parsed.messages && Array.isArray(parsed.messages)) {
        return "slack";
      }
    } catch {
      // Not valid JSON, continue
    }
  }

  // Meeting: common meeting note patterns
  if (
    /meeting date:/i.test(contentStart) ||
    /attendees:/i.test(contentStart) ||
    /duration:/i.test(contentStart) ||
    (/platform:/i.test(contentStart) &&
      /(zoom|teams|meet|webex)/i.test(contentStart))
  ) {
    return "meeting";
  }

  // 5. File extension from source
  const extMatch = item.source.match(/\.([a-z0-9]+)$/i);
  if (extMatch) {
    const ext = "." + extMatch[1].toLowerCase();

    if (CODE_EXTENSIONS.has(ext)) {
      return "code";
    }
    if (ext === ".pdf") {
      return "pdf";
    }
    if (IMAGE_EXTENSIONS.has(ext)) {
      return "image";
    }
    if (ARTICLE_EXTENSIONS.has(ext)) {
      return "article";
    }
  }

  // 6. Fallback
  return "text";
}
