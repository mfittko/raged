import { randomUUID } from "node:crypto";
import type { EnrichmentTask } from "../redis.js";

export interface EnrichmentStatusRequest {
  baseId: string;
  collection?: string;
}

export interface EnrichmentStatusResult {
  baseId: string;
  status: "enriched" | "processing" | "pending" | "failed" | "none" | "mixed";
  chunks: {
    total: number;
    enriched: number;
    pending: number;
    processing: number;
    failed: number;
    none: number;
  };
  extractedAt?: string;
  metadata?: {
    tier2?: Record<string, unknown>;
    tier3?: Record<string, unknown>;
  };
}

export interface EnrichmentStatsResult {
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

export interface EnqueueRequest {
  collection?: string;
  force?: boolean;
}

export interface EnqueueResult {
  ok: true;
  enqueued: number;
}

export interface EnrichmentDeps {
  collectionName: (name?: string) => string;
  scrollPoints: (
    collection: string,
    filter?: Record<string, unknown>,
    limit?: number,
  ) => Promise<
    Array<{
      id: string;
      payload?: Record<string, unknown>;
    }>
  >;
  getQueueLength: (queueName: string) => Promise<number>;
  enqueueTask: (task: EnrichmentTask) => Promise<void>;
  getPointsByBaseId: (
    collection: string,
    baseId: string,
  ) => Promise<
    Array<{
      id: string;
      payload?: Record<string, unknown>;
    }>
  >;
}

export async function getEnrichmentStatus(
  request: EnrichmentStatusRequest,
  deps: EnrichmentDeps,
): Promise<EnrichmentStatusResult> {
  const col = deps.collectionName(request.collection);
  const chunks = await deps.getPointsByBaseId(col, request.baseId);

  if (chunks.length === 0) {
    throw new Error(`No chunks found for baseId: ${request.baseId}`);
  }

  const statusCounts = {
    enriched: 0,
    pending: 0,
    processing: 0,
    failed: 0,
    none: 0,
  };

  let latestExtractedAt: string | undefined;
  let tier2Meta: Record<string, unknown> | undefined;
  let tier3Meta: Record<string, unknown> | undefined;

  for (const chunk of chunks) {
    const status = (chunk.payload?.enrichmentStatus as string) || "none";
    if (status in statusCounts) {
      statusCounts[status as keyof typeof statusCounts]++;
    }

    if (status === "enriched" && chunk.payload) {
      const extractedAt = chunk.payload.enrichedAt as string | undefined;
      if (extractedAt && (!latestExtractedAt || extractedAt > latestExtractedAt)) {
        latestExtractedAt = extractedAt;
      }

      if (chunk.payload.tier2Meta) {
        tier2Meta = chunk.payload.tier2Meta as Record<string, unknown>;
      }
      if (chunk.payload.tier3Meta) {
        tier3Meta = chunk.payload.tier3Meta as Record<string, unknown>;
      }
    }
  }

  // Determine overall status
  let status: "enriched" | "processing" | "pending" | "failed" | "none" | "mixed";
  if (statusCounts.enriched === chunks.length) {
    status = "enriched";
  } else if (statusCounts.pending === chunks.length) {
    status = "pending";
  } else if (statusCounts.processing === chunks.length) {
    status = "processing";
  } else if (statusCounts.none === chunks.length) {
    status = "none";
  } else if (statusCounts.failed > 0) {
    status = "failed";
  } else {
    status = "mixed";
  }

  const result: EnrichmentStatusResult = {
    baseId: request.baseId,
    status,
    chunks: {
      total: chunks.length,
      ...statusCounts,
    },
  };

  if (latestExtractedAt) {
    result.extractedAt = latestExtractedAt;
  }

  if (tier2Meta || tier3Meta) {
    result.metadata = {};
    if (tier2Meta) result.metadata.tier2 = tier2Meta;
    if (tier3Meta) result.metadata.tier3 = tier3Meta;
  }

  return result;
}

export async function getEnrichmentStats(
  deps: Pick<EnrichmentDeps, "getQueueLength" | "scrollPoints" | "collectionName">,
): Promise<EnrichmentStatsResult> {
  // Get queue lengths from Redis
  const [pending, deadLetter] = await Promise.all([
    deps.getQueueLength("enrichment:pending"),
    deps.getQueueLength("enrichment:dead-letter"),
  ]);

  // Count processing items by scrolling through collection
  // Note: This uses a high limit for initial implementation. For very large
  // collections (>10k items), consider implementing pagination or caching.
  const col = deps.collectionName();
  const allPoints = await deps.scrollPoints(col, undefined, 10000);

  const totals = {
    enriched: 0,
    failed: 0,
    pending: 0,
    processing: 0,
    none: 0,
  };

  for (const point of allPoints) {
    const status = (point.payload?.enrichmentStatus as string) || "none";
    if (status in totals) {
      totals[status as keyof typeof totals]++;
    }
  }

  return {
    queue: {
      pending,
      processing: totals.processing,
      deadLetter,
    },
    totals,
  };
}

export async function enqueueEnrichment(
  request: EnqueueRequest,
  deps: EnrichmentDeps,
): Promise<EnqueueResult> {
  const col = deps.collectionName(request.collection);

  // Build filter for items that need enrichment
  const filter = request.force
    ? undefined
    : {
        must_not: [
          {
            key: "enrichmentStatus",
            match: { value: "enriched" },
          },
        ],
      };

  // Note: This uses a high limit for initial implementation. For very large
  // collections (>10k items), consider implementing pagination or batching.
  const points = await deps.scrollPoints(col, filter, 10000);

  let enqueued = 0;
  for (const point of points) {
    const payload = point.payload;
    if (!payload) continue;

    const task: EnrichmentTask = {
      taskId: randomUUID(),
      qdrantId: point.id,
      collection: col,
      docType: (payload.docType as string) || "text",
      baseId: extractBaseId(point.id),
      chunkIndex: (payload.chunkIndex as number) || 0,
      totalChunks: 1,
      text: (payload.text as string) || "",
      source: (payload.source as string) || "",
      tier1Meta: (payload.tier1Meta as Record<string, unknown>) || {},
      attempt: 1,
      enqueuedAt: new Date().toISOString(),
    };

    await deps.enqueueTask(task);
    enqueued++;
  }

  return { ok: true, enqueued };
}

function extractBaseId(qdrantId: string): string {
  // Format is typically "baseId:chunkIndex"
  const lastColon = qdrantId.lastIndexOf(":");
  if (lastColon === -1) return qdrantId;
  return qdrantId.substring(0, lastColon);
}
