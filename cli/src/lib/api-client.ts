import type { IngestItem, IngestResponse } from "./types.js";

function authHeaders(token?: string): Record<string, string> {
  const t = token || process.env.RAG_API_TOKEN || "";
  if (!t) return {};
  return { authorization: `Bearer ${t}` };
}

export async function ingest(
  api: string,
  collection: string,
  items: IngestItem[],
  token?: string,
  enrich?: boolean
): Promise<IngestResponse> {
  const body: { collection: string; items: IngestItem[]; enrich?: boolean } = { collection, items };
  if (enrich !== undefined) body.enrich = enrich;

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
  filter?: unknown,
  token?: string
): Promise<{ results: unknown[] }> {
  const res = await fetch(`${api.replace(/\/$/, "")}/query`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders(token) },
    body: JSON.stringify({ collection, query: q, topK, filter }),
  });
  if (!res.ok) throw new Error(`Query failed: ${res.status} ${await res.text()}`);
  return await res.json();
}

export async function getEnrichmentStats(api: string, token?: string): Promise<unknown> {
  const res = await fetch(`${api.replace(/\/$/, "")}/enrichment/stats`, {
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
  token?: string
): Promise<{ enqueued: number }> {
  const res = await fetch(`${api.replace(/\/$/, "")}/enrichment/enqueue`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders(token) },
    body: JSON.stringify({ collection, force }),
  });
  if (!res.ok) throw new Error(`Failed to enqueue: ${res.status} ${await res.text()}`);
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
      throw new Error("Graph functionality is not enabled (Neo4j not configured).");
    }
    throw new Error(`Failed to get entity: ${res.status} ${await res.text()}`);
  }

  return await res.json();
}
