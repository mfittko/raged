import { describe, it, expect } from "vitest";
import { extractMeeting } from "./meeting.js";
import type { IngestItem } from "../doctype.js";

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

  it("should detect platform from content when not explicitly stated", () => {
    const item: IngestItem = {
      text: "We had a teams call today about the project.\n\nNotes...",
      source: "meeting.txt",
    };
    const result = extractMeeting(item);
    expect(result.platform).toBe("teams");
  });

  it("should handle semicolon-separated participants", () => {
    const item: IngestItem = {
      text: "Participants: Alice; Bob; Charlie\n\n",
      source: "meeting.txt",
    };
    const result = extractMeeting(item);
    expect(result.participants).toEqual(["Alice", "Bob", "Charlie"]);
  });

  it("should return empty object when no text provided", () => {
    const item: IngestItem = {
      source: "meeting.txt",
    };
    const result = extractMeeting(item);
    expect(result).toEqual({});
  });
});
