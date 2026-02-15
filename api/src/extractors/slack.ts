import type { IngestItem } from "../doctype.js";

export interface SlackMetadata {
  channel?: string;
  threadId?: string;
  participants?: string[];
  timestamp?: string;
  [key: string]: unknown;
}

export function extractSlack(item: IngestItem): SlackMetadata {
  const result: SlackMetadata = {};

  // Try to parse as JSON (Slack export format)
  const text = item.text;
  if (!text) {
    // No text, try metadata fallback
    if (item.metadata?.channel) {
      result.channel = String(item.metadata.channel);
    }
    if (item.metadata?.threadId) {
      result.threadId = String(item.metadata.threadId);
    }
    return result;
  }
  
  try {
    const parsed = JSON.parse(text);

    // Single message format
    if (parsed.channel) {
      result.channel = parsed.channel;
    }
    if (parsed.thread_ts) {
      result.threadId = parsed.thread_ts;
    }
    if (parsed.ts) {
      result.timestamp = parsed.ts;
    }
    if (parsed.user || parsed.username) {
      result.participants = [parsed.user || parsed.username];
    }

    // Slack export format with messages array
    if (parsed.messages && Array.isArray(parsed.messages)) {
      const users = new Set<string>();
      for (const msg of parsed.messages) {
        if (msg.user) users.add(msg.user);
        if (msg.username) users.add(msg.username);
      }
      if (users.size > 0) {
        result.participants = Array.from(users);
      }
      // Use first message timestamp if available
      if (parsed.messages[0]?.ts) {
        result.timestamp = parsed.messages[0].ts;
      }
    }
  } catch {
    // Not JSON, try metadata fallback
    if (item.metadata?.channel) {
      result.channel = String(item.metadata.channel);
    }
    if (item.metadata?.threadId) {
      result.threadId = String(item.metadata.threadId);
    }
  }

  return result;
}
