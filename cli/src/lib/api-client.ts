import type { CollectionStats, IngestItem, IngestResponse, QueryResponse } from "./types.js";

function authHeaders(token?: string): Record<string, string> {
  const t = token || process.env.RAGED_API_TOKEN || "";
  if (!t) return {};
  return { authorization: `Bearer ${t}` };
}

export async function ingest(
  api: string,
  collection: string,
  items: IngestItem[],
  token?: string,
  enrich?: boolean,
  overwrite?: boolean,
): Promise<IngestResponse> {
  const body: { collection: string; items: IngestItem[]; enrich?: boolean; overwrite?: boolean } = { collection, items };
  if (enrich !== undefined) body.enrich = enrich;
  if (overwrite === true) body.overwrite = true;

  const res = await fetch(`${api.replace(/\/$/, "")}/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders(token) },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Ingest failed: ${res.status} ${await res.text()}`);
  return await res.json();
}

export async function query(
  api: string,
  collection: string,
  q: string,
  topK: number,
  minScore: number,
  filter?: unknown,
  strategy?: string,
  token?: string
): Promise<QueryResponse> {
  const body: Record<string, unknown> = { collection, query: q, topK, minScore, filter };
  if (strategy !== undefined) body.strategy = strategy;
  const res = await fetch(`${api.replace(/\/$/, "")}/query`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders(token) },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Query failed: ${res.status} ${await res.text()}`);
  return await res.json() as QueryResponse;
}

export async function downloadFirstQueryMatch(
  api: string,
  collection: string,
  q: string,
  topK: number,
  minScore: number,
  filter?: unknown,
  token?: string
): Promise<{ data: Buffer; fileName: string; source: string; mimeType: string }> {
  const res = await fetch(`${api.replace(/\/$/, "")}/query/download-first`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders(token) },
    body: JSON.stringify({ collection, query: q, topK, minScore, filter }),
  });

  if (!res.ok) {
    throw new Error(`Download failed: ${res.status} ${await res.text()}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  const contentDisposition = res.headers.get("content-disposition") || "";
  const match = /filename="?([^";]+)"?/i.exec(contentDisposition);
  const fileName = match?.[1] || "download.bin";

  return {
    data: Buffer.from(arrayBuffer),
    fileName,
    source: res.headers.get("x-raged-source") || "",
    mimeType: res.headers.get("content-type") || "application/octet-stream",
  };
}

export async function downloadFirstQueryMatchText(
  api: string,
  collection: string,
  q: string,
  topK: number,
  minScore: number,
  filter?: unknown,
  token?: string
): Promise<{ text: string; fileName: string; source: string }> {
  const res = await fetch(`${api.replace(/\/$/, "")}/query/fulltext-first`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders(token) },
    body: JSON.stringify({ collection, query: q, topK, minScore, filter }),
  });

  if (!res.ok) {
    throw new Error(`Full text download failed: ${res.status} ${await res.text()}`);
  }

  const contentDisposition = res.headers.get("content-disposition") || "";
  const match = /filename="?([^";]+)"?/i.exec(contentDisposition);
  const fileName = match?.[1] || "document.txt";

  return {
    text: await res.text(),
    fileName,
    source: res.headers.get("x-raged-source") || "",
  };
}

export async function getEnrichmentStats(api: string, collection?: string, filter?: string, token?: string): Promise<unknown> {
  const params = new URLSearchParams();
  if (collection && collection.trim()) {
    params.set("collection", collection.trim());
  }
  if (filter && filter.trim()) {
    params.set("filter", filter.trim());
  }

  const qs = params.toString();
  const res = await fetch(`${api.replace(/\/$/, "")}/enrichment/stats${qs ? `?${qs}` : ""}`, {
    method: "GET",
    headers: authHeaders(token),
  });
  if (!res.ok) throw new Error(`Failed to get stats: ${res.status} ${await res.text()}`);
  return await res.json();
}

export async function enqueueEnrichment(
  api: string,
  collection: string,
  force: boolean,
  filter?: string,
  token?: string
): Promise<{ enqueued: number }> {
  const body: { collection: string; force: boolean; filter?: string } = { collection, force };
  if (filter && filter.trim()) {
    body.filter = filter.trim();
  }

  const res = await fetch(`${api.replace(/\/$/, "")}/enrichment/enqueue`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders(token) },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Failed to enqueue: ${res.status} ${await res.text()}`);
  return await res.json();
}

export async function clearEnrichmentQueue(
  api: string,
  collection: string,
  filter?: string,
  token?: string
): Promise<{ cleared: number }> {
  const body: { collection: string; filter?: string } = { collection };
  if (filter && filter.trim()) {
    body.filter = filter.trim();
  }

  const res = await fetch(`${api.replace(/\/$/, "")}/enrichment/clear`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders(token) },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Failed to clear queue: ${res.status} ${await res.text()}`);
  return await res.json();
}

export async function getGraphEntity(api: string, entity: string, token?: string): Promise<unknown> {
  const res = await fetch(`${api.replace(/\/$/, "")}/graph/entity/${encodeURIComponent(entity)}`, {
    method: "GET",
    headers: authHeaders(token),
  });

  if (!res.ok) {
    if (res.status === 404) {
      return null;
    }
    if (res.status === 503) {
      throw new Error("Graph functionality is not enabled.");
    }
    throw new Error(`Failed to get entity: ${res.status} ${await res.text()}`);
  }

  return await res.json();
}

export async function getCollections(api: string, token?: string): Promise<CollectionStats[]> {
  const res = await fetch(`${api.replace(/\/$/, "")}/collections`, {
    method: "GET",
    headers: authHeaders(token),
  });

  if (!res.ok) {
    throw new Error(`Failed to list collections: ${res.status} ${await res.text()}`);
  }

  const body = await res.json() as { collections?: CollectionStats[] };
  return Array.isArray(body.collections) ? body.collections : [];
}
