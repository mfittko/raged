// Shared types for enrichment

export interface EnrichmentTask {
  taskId: string;
  qdrantId: string;
  collection: string;
  docType: string;
  baseId: string;
  chunkIndex: number;
  totalChunks: number;
  text: string;
  source: string;
  tier1Meta: Record<string, unknown>;
  attempt: number;
  enqueuedAt: string;
}
