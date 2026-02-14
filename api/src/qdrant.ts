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

export async function ensureCollection(name = DEFAULT_COLLECTION) {
  const collections = await qdrant.getCollections();
  const exists = collections.collections?.some((c) => c.name === name);
  if (exists) return;
  await qdrant.createCollection(name, { vectors: { size: VECTOR_SIZE, distance: DISTANCE } });
}

export function collectionName(name?: string) {
  return name || DEFAULT_COLLECTION;
}

export async function getPointsByBaseId(
  collection: string,
  baseId: string,
) {
  // Fetch all points and filter client-side for baseId prefix matching
  // Note: Qdrant doesn't support prefix matching in filters, so we fetch
  // a reasonable batch and filter in-memory. For very large collections,
  // consider implementing pagination.
  const allPoints = await qdrant.scroll(collection, {
    limit: 1000,
  });

  const matchingPoints = allPoints.points.filter((p) => {
    const id = String(p.id);
    return id === baseId || id.startsWith(`${baseId}:`);
  });

  return matchingPoints.map((p) => ({
    id: String(p.id),
    payload: p.payload as Record<string, unknown> | undefined,
  }));
}

export async function scrollPoints(
  collection: string,
  filter?: Record<string, unknown>,
  limit = 100,
) {
  const result = await qdrant.scroll(collection, {
    filter,
    limit,
  });

  return result.points.map((p) => ({
    id: String(p.id),
    payload: p.payload as Record<string, unknown> | undefined,
  }));
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
