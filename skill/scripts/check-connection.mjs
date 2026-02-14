/**
 * Pre-flight check: verifies rag-stack is running and responsive.
 * Used by the OpenClaw agent before issuing query/index commands.
 *
 * Usage: node check-connection.mjs [url]
 *   url defaults to RAG_STACK_URL env var, then http://localhost:8080
 */

export async function checkConnection(url, fetchFn = fetch) {
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
    return { ok: false, url: baseUrl, error: err.message };
  }
}

// CLI entry point
const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("/check-connection.mjs");

if (isMain) {
  const url = process.argv[2] || process.env.RAG_STACK_URL || "http://localhost:8080";
  const result = await checkConnection(url);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}
