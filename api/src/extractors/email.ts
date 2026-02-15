import type { IngestItem } from "../doctype.js";

export interface EmailMetadata {
  from?: string;
  to?: string[];
  cc?: string[];
  subject?: string;
  date?: string;
  messageId?: string;
  inReplyTo?: string;
  references?: string[];
  [key: string]: unknown;
}

export function extractEmail(item: IngestItem): EmailMetadata {
  const result: EmailMetadata = {};
  const text = item.text;
  
  // Early return if no text available
  if (!text) {
    return result;
  }

  // Split headers and body at first blank line
  const headerEndIndex = text.indexOf("\n\n");
  const headerText =
    headerEndIndex > 0 ? text.substring(0, headerEndIndex) : text;

  // Parse headers using regex
  const headers = headerText.split("\n");
  for (const line of headers) {
    const match = line.match(/^([A-Za-z-]+):\s*(.+)$/);
    if (!match) continue;

    const [, name, value] = match;
    const lowerName = name.toLowerCase();

    switch (lowerName) {
      case "from":
        result.from = value.trim();
        break;
      case "to":
        result.to = value
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s);
        break;
      case "cc":
        result.cc = value
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s);
        break;
      case "subject":
        result.subject = value.trim();
        break;
      case "date":
        result.date = value.trim();
        break;
      case "message-id":
        result.messageId = value.trim();
        break;
      case "in-reply-to":
        result.inReplyTo = value.trim();
        break;
      case "references":
        result.references = value
          .split(/\s+/)
          .map((s) => s.trim())
          .filter((s) => s);
        break;
    }
  }

  return result;
}
