import { randomUUID } from "node:crypto";
import type { EnrichmentTask } from "../types.js";

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
  scrollPointsPage: (
    collection: string,
    filter?: Record<string, unknown>,
    limit?: number,
    offset?: string | number | Record<string, unknown> | null,
  ) => Promise<{
    points: Array<{
      id: string;
      payload?: Record<string, unknown>;
    }>;
    nextOffset: string | number | Record<string, unknown> | null;
  }>;
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
    const error = new Error(`No chunks found for baseId: ${request.baseId}`) as Error & { statusCode?: number };
    error.statusCode = 404;
    throw error;
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

      if (chunk.payload.tier2) {
        tier2Meta = chunk.payload.tier2 as Record<string, unknown>;
      }
      if (chunk.payload.tier3) {
        tier3Meta = chunk.payload.tier3 as Record<string, unknown>;
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
  deps: Pick<EnrichmentDeps, "getQueueLength" | "scrollPointsPage" | "collectionName">,
): Promise<EnrichmentStatsResult> {
  // Get queue lengths from Redis
  const [pending, deadLetter] = await Promise.all([
    deps.getQueueLength("enrichment:pending"),
    deps.getQueueLength("enrichment:dead-letter"),
  ]);

  // Stream through collection in pages to avoid loading all points into memory
  const col = deps.collectionName();
  const PAGE_SIZE = 500;
  
  const totals = {
    enriched: 0,
    failed: 0,
    pending: 0,
    processing: 0,
    none: 0,
  };

  let offset: string | number | Record<string, unknown> | null = null;

  while (true) {
    const page = await deps.scrollPointsPage(col, undefined, PAGE_SIZE, offset);
    
    for (const point of page.points) {
      const status = (point.payload?.enrichmentStatus as string) || "none";
      if (status in totals) {
        totals[status as keyof typeof totals]++;
      }
    }

    if (page.nextOffset === null) {
      break;
    }
    offset = page.nextOffset;
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

  // Stream through collection in pages to avoid loading all points into memory
  const PAGE_SIZE = 500;
  const BATCH_SIZE = 100;
  
  let enqueued = 0;
  const baseIdToTotalChunks = new Map<string, number>();
  const pendingTasks: EnrichmentTask[] = [];

  let offset: string | number | Record<string, unknown> | null = null;

  // First pass: count chunks per baseId across the entire filtered dataset
  while (true) {
    const page = await deps.scrollPointsPage(col, filter, PAGE_SIZE, offset);

    for (const point of page.points) {
      const baseId = extractBaseId(point.id);
      const current = baseIdToTotalChunks.get(baseId) ?? 0;
      baseIdToTotalChunks.set(baseId, current + 1);
    }

    if (page.nextOffset === null) {
      break;
    }
    offset = page.nextOffset;
  }

  // Second pass: build and enqueue tasks with correct totalChunks values
  offset = null;
  while (true) {
    const page = await deps.scrollPointsPage(col, filter, PAGE_SIZE, offset);

    for (const point of page.points) {
      const payload = point.payload;
      if (!payload) continue;

      const baseId = extractBaseId(point.id);
      const totalChunks = baseIdToTotalChunks.get(baseId) ?? 1;

      const task: EnrichmentTask = {
        taskId: randomUUID(),
        chunkId: point.id,
        collection: col,
        docType: (payload.docType as string) || "text",
        baseId,
        chunkIndex: (payload.chunkIndex as number) || 0,
        totalChunks,
        text: (payload.text as string) || "",
        source: (payload.source as string) || "",
        tier1Meta: (payload.tier1Meta as Record<string, unknown>) || {},
        attempt: 1,
        enqueuedAt: new Date().toISOString(),
      };

      pendingTasks.push(task);
      
      // Batch enqueue when we have enough tasks
      if (pendingTasks.length >= BATCH_SIZE) {
        await Promise.all(pendingTasks.map((t) => deps.enqueueTask(t)));
        enqueued += pendingTasks.length;
        pendingTasks.length = 0;
      }
    }

    if (page.nextOffset === null) {
      break;
    }
    offset = page.nextOffset;
  }

  // Enqueue any remaining tasks
  if (pendingTasks.length > 0) {
    await Promise.all(pendingTasks.map((t) => deps.enqueueTask(t)));
    enqueued += pendingTasks.length;
  }

  return { ok: true, enqueued };
}

function extractBaseId(chunkId: string): string {
  // Format is typically "baseId:chunkIndex"
  const lastColon = chunkId.lastIndexOf(":");
  if (lastColon === -1) return chunkId;
  return chunkId.substring(0, lastColon);
}
