import type { IngestItem } from "../doctype.js";

export interface MeetingMetadata {
  date?: string;
  duration?: string;
  platform?: string;
  participants?: string[];
  [key: string]: unknown;
}

export function extractMeeting(item: IngestItem): MeetingMetadata {
  const result: MeetingMetadata = {};
  const text = item.text;
  
  // Early return if no text available
  if (!text) {
    return result;
  }

  // Extract date
  const dateMatch = text.match(/(?:meeting\s+)?date:\s*([^\n]+)/i);
  if (dateMatch) {
    result.date = dateMatch[1].trim();
  }

  // Extract duration
  const durationMatch = text.match(/duration:\s*([^\n]+)/i);
  if (durationMatch) {
    result.duration = durationMatch[1].trim();
  }

  // Extract platform
  const platformMatch = text.match(/platform:\s*([^\n]+)/i);
  if (platformMatch) {
    result.platform = platformMatch[1].trim();
  } else {
    // Fallback: detect common platforms in text
    const platformDetect = text.match(/\b(zoom|teams|meet|webex)\b/i);
    if (platformDetect) {
      result.platform = platformDetect[1].toLowerCase();
    }
  }

  // Extract attendees/participants
  const attendeesMatch = text.match(
    /(?:attendees|participants):\s*([^\n]+)/i,
  );
  if (attendeesMatch) {
    result.participants = attendeesMatch[1]
      .split(/[,;]/)
      .map((s) => s.trim())
      .filter((s) => s);
  }

  return result;
}
