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

/** @deprecated Use `QueryResultItem` instead. */
export interface QueryResult {
  text?: string;
  score: number;
  source: string;
  payload?: Record<string, unknown>;
}

export interface QueryResultItem {
  id: string | number;
  score: number;
  source?: string;
  text?: string;
  payload?: Record<string, unknown>;
}

export interface RoutingDecision {
  strategy: "metadata" | "graph" | "semantic" | "hybrid";
  method: "explicit" | "rule" | "llm" | "rule_fallback" | "default";
  confidence: number;
  rule?: string;
  durationMs: number;
}

export interface GraphMeta {
  entityCount: number;
  capped: boolean;
  timedOut: boolean;
  warnings: string[];
}

export interface GraphEntity {
  name: string;
  type: string;
  depth: number;
  isSeed: boolean;
  mentionCount?: number;
  description?: string;
}

export interface GraphEdge {
  source: string;
  target: string;
  type: string;
}

export interface EntityPath {
  entities: string[];
  relationships: string[];
  depth: number;
}

export interface EntityDocument {
  documentId: string;
  source: string;
  entityName: string;
  mentionCount: number;
}

export interface GraphResult {
  entities: GraphEntity[];
  relationships: GraphEdge[];
  paths: EntityPath[];
  documents?: EntityDocument[];
  meta: GraphMeta;
}

export interface QueryResponse {
  ok: true;
  results: QueryResultItem[];
  graph?: GraphResult;
  routing: RoutingDecision;
}

export interface CollectionStats {
  collection: string;
  documentCount: number;
  chunkCount: number;
  enrichedChunkCount: number;
  lastSeenAt: string | null;
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

// ---------------------------------------------------------------------------
// CLI filter DSL types
// ---------------------------------------------------------------------------

export interface CliFilterCondition {
  field: string;
  op: string;
  value?: string;
  values?: string[];
  range?: { low: string; high: string };
  alias?: string;
}

export interface CliFilterDSL {
  conditions: CliFilterCondition[];
  combine?: "and" | "or";
}
