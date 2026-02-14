import { QdrantClient } from "@qdrant/js-client-rest";

const QDRANT_URL = process.env.QDRANT_URL || "http://qdrant:6333";
const DEFAULT_COLLECTION = process.env.QDRANT_COLLECTION || "docs";
const VECTOR_SIZE = Number(process.env.VECTOR_SIZE || "768");

type DistanceMetric = "Cosine" | "Euclid" | "Dot";

const VALID_DISTANCES: DistanceMetric[] = ["Cosine", "Euclid", "Dot"];

function getDistance(): DistanceMetric {
  const envDistance = process.env.DISTANCE;
  if (envDistance && (VALID_DISTANCES as readonly string[]).includes(envDistance)) {
    return envDistance as DistanceMetric;
  }
  return "Cosine";
}

const DISTANCE: DistanceMetric = getDistance();

export const qdrant = new QdrantClient({ url: QDRANT_URL });

interface QdrantErrorWithStatus {
  status?: number;
  response?: {
    status?: number;
  };
}

function getErrorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }

  const maybe = error as QdrantErrorWithStatus;
  if (typeof maybe.status === "number") {
    return maybe.status;
  }
  if (typeof maybe.response?.status === "number") {
    return maybe.response.status;
  }

  return undefined;
}

export async function ensureCollection(name = DEFAULT_COLLECTION) {
  const collections = await qdrant.getCollections();
  const exists = collections.collections?.some((c) => c.name === name);
  if (!exists) {
    await qdrant.createCollection(name, { vectors: { size: VECTOR_SIZE, distance: DISTANCE } });
  }
  
  // Create payload indexes for filterable fields to avoid full collection scans
  // Required indexes per AGENTS.md performance requirements
  const payloadIndexes = [
    "enrichmentStatus", // used in enrichment queries
    "repoId",          // used in CLI filtering
    "path",            // used in CLI filtering  
    "lang",            // used in CLI filtering
    "baseId",          // used in getPointsByBaseId (see task #7)
  ];
  
  for (const fieldName of payloadIndexes) {
    try {
      await qdrant.createPayloadIndex(name, {
        field_name: fieldName,
        field_schema: "keyword",
      });
    } catch (error: unknown) {
      const status = getErrorStatus(error);
      if (status !== 409) {
        throw error;
      }
    }
  }
}

export function collectionName(name?: string) {
  return name || DEFAULT_COLLECTION;
}

export async function getPointsByBaseId(
  collection: string,
  baseId: string,
) {
  // Required index: baseId (string) — created in ensureCollection (task #6)
  // Use indexed server-side filter instead of client-side scan
  const matchingPoints: Array<{ id: string; payload: Record<string, unknown> | undefined }> = [];
  let nextPageOffset: string | number | Record<string, unknown> | null | undefined = undefined;

  do {
    const page = await qdrant.scroll(collection, {
      filter: {
        must: [
          {
            key: "baseId",
            match: { value: baseId },
          },
        ],
      },
      limit: 1000,
      ...(nextPageOffset !== undefined && nextPageOffset !== null ? { offset: nextPageOffset } : {}),
    });

    for (const p of page.points) {
      matchingPoints.push({
        id: String(p.id),
        payload: p.payload as Record<string, unknown> | undefined,
      });
    }

    nextPageOffset = page.next_page_offset ?? null;
  } while (nextPageOffset !== undefined && nextPageOffset !== null);

  return matchingPoints;
}

export async function scrollPoints(
  collection: string,
  filter?: Record<string, unknown>,
  limit = 100,
) {
  // Required indexes (when filter is used):
  // - enrichmentStatus (string)
  // - repoId (string) 
  // - path (string)
  // - lang (string)
  // See task #6 for index creation
  const allPoints: Array<{ id: string; payload: Record<string, unknown> | undefined }> = [];
  let nextPageOffset: string | number | Record<string, unknown> | null | undefined = undefined;

  while (true) {
    const remaining = limit - allPoints.length;
    if (remaining <= 0) {
      break;
    }

    const result = await qdrant.scroll(collection, {
      filter,
      limit: Math.min(remaining, 1000),
      ...(nextPageOffset !== undefined && nextPageOffset !== null ? { offset: nextPageOffset } : {}),
    });

    const pagePoints = result.points.map((p) => ({
      id: String(p.id),
      payload: p.payload as Record<string, unknown> | undefined,
    }));

    allPoints.push(...pagePoints);
    nextPageOffset = result.next_page_offset ?? null;

    if (nextPageOffset === undefined || nextPageOffset === null) {
      break;
    }
  }

  return allPoints;
}

export async function scrollPointsPage(
  collection: string,
  filter?: Record<string, unknown>,
  limit = 100,
  offset?: string | number | Record<string, unknown> | null,
) {
  const result = await qdrant.scroll(collection, {
    filter,
    limit,
    ...(offset !== undefined && offset !== null ? { offset } : {}),
  });

  return {
    points: result.points.map((p) => ({
      id: String(p.id),
      payload: p.payload as Record<string, unknown> | undefined,
    })),
    nextOffset: result.next_page_offset ?? null,
  };
}

export async function getPointsByIds(
  collection: string,
  ids: string[],
) {
  if (ids.length === 0) return [];

  const result = await qdrant.retrieve(collection, { ids });

  return result.map((p) => ({
    id: String(p.id),
    score: 1.0, // Retrieved points don't have a score
    payload: p.payload as Record<string, unknown> | undefined,
  }));
}
