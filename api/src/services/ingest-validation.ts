import type { IngestRequest } from "./ingest.js";

export interface IngestValidationError {
  error: string;
}

export function validateIngestRequest(body: IngestRequest): IngestValidationError | null {
  if (!body.items || !Array.isArray(body.items)) {
    return null;
  }

  let urlCount = 0;

  for (const item of body.items) {
    if (!item.text && !item.url) {
      return {
        error: "Validation failed: each item must have either 'text' or 'url'",
      };
    }

    if (!item.url && !item.source) {
      return {
        error: "Validation failed: 'source' is required when 'url' is not provided",
      };
    }

    if (item.url) {
      urlCount++;
    }
  }

  if (urlCount > 50) {
    return {
      error: `Validation failed: maximum 50 URL items per request (found ${urlCount})`,
    };
  }

  return null;
}