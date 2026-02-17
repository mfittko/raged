export interface IngestItem {
  id?: string;
  text?: string;
  url?: string;
  source?: string;
  rawData?: string;
  rawMimeType?: string;
  metadata?: Record<string, unknown>;
  docType?: string;
}

export interface QueryResult {
  text?: string;
  score: number;
  source: string;
}

export interface IngestResponse {
  upserted: number;
  skipped?: number;
  errors?: Array<{
    url: string;
    reason: string;
  }>;
}

export interface EnrichmentStats {
  queue: {
    pending: number;
    processing: number;
    deadLetter: number;
  };
  totals: {
    enriched: number;
    failed: number;
    pending: number;
    processing: number;
    none: number;
  };
}

export interface GraphEntityResponse {
  entity: {
    name: string;
    type: string;
    description?: string;
  };
  connections?: Array<{
    entity: string;
    relationship: string;
    direction: string;
  }>;
  documents?: Array<{
    id: string;
  }>;
}
