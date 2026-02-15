import { describe, it, expect } from "vitest";
import { extractImage } from "./image.js";
import type { IngestItem } from "../doctype.js";

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

  it("should handle missing dimensions", () => {
    const item: IngestItem = {
      text: "Image description",
      source: "photo.png",
      metadata: {
        mimeType: "image/png",
      },
    };
    const result = extractImage(item);
    expect(result.mimeType).toBe("image/png");
    expect(result.dimensions).toBeUndefined();
  });

  it("should return empty object when no metadata provided", () => {
    const item: IngestItem = {
      text: "Image description",
      source: "photo.jpg",
    };
    const result = extractImage(item);
    expect(result).toEqual({});
  });
});
