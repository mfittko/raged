import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Pre-flight check: verifies raged is running and responsive.
 * Used by the OpenClaw agent before issuing query/index commands.
 *
 * Usage: node check-connection.mjs [url]
 *   url defaults to RAGED_URL env var, then http://localhost:8080
 */

export async function checkConnection(url, fetchFn = fetch) {
  if (!url || typeof url !== "string") {
    return { ok: false, url: String(url), error: "No URL provided" };
  }
  const baseUrl = url.replace(/\/+$/, "");
  try {
    const res = await fetchFn(`${baseUrl}/healthz`);
    if (!res.ok) {
      return { ok: false, url: baseUrl, error: `Health check returned ${res.status}` };
    }
    const body = await res.json();
    if (!body.ok) {
      return { ok: false, url: baseUrl, error: "Health endpoint returned ok:false" };
    }
    return { ok: true, url: baseUrl };
  } catch (err) {
    return {
      ok: false,
      url: baseUrl,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// CLI entry point
const entryArg = process.argv[1];
const entryUrl = entryArg ? pathToFileURL(resolve(entryArg)).href : "";
const isMain = import.meta.url === entryUrl;

if (isMain) {
  const url = process.argv[2] || process.env.RAGED_URL || "http://localhost:8080";
  const result = await checkConnection(url);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}
