import { logger } from "./logger.js";

const FETCH_TIMEOUT_MS = 10_000;
const MAX_CONTENT_CHARS = 1500;
const OPENAI_DEFAULT_MODEL = "gpt-4o-mini";

interface UrlCheckResult {
  url: string;
  reachable: boolean;
  meaningful: boolean;
  reason: string;
}

function stripHtml(html: string): string {
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#\d+;/g, " ");

  text = text.replace(/\s+/g, " ").trim();
  return text;
}

async function fetchSnippet(url: string): Promise<{ ok: boolean; snippet: string; error?: string }> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent": "raged-url-check/1.0",
        accept: "text/html, application/xhtml+xml, text/plain, */*",
      },
      redirect: "follow",
    });

    clearTimeout(timer);

    if (!res.ok) {
      return { ok: false, snippet: "", error: `HTTP ${res.status}` };
    }

    const contentType = res.headers.get("content-type") || "";

    // Skip binary content (images, videos, archives, etc.)
    if (
      contentType.startsWith("image/") ||
      contentType.startsWith("video/") ||
      contentType.startsWith("audio/") ||
      contentType.startsWith("application/octet-stream") ||
      contentType.startsWith("application/zip")
    ) {
      return { ok: false, snippet: "", error: `binary content-type: ${contentType}` };
    }

    const body = await res.text();

    const isHtml =
      contentType.includes("html") || body.trimStart().startsWith("<");
    const plainText = isHtml ? stripHtml(body) : body;

    const snippet = plainText.slice(0, MAX_CONTENT_CHARS);
    return { ok: true, snippet };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, snippet: "", error: message };
  }
}

async function askOpenAiMeaningful(
  snippet: string,
  url: string,
  apiKey: string,
  baseUrl: string,
  model: string,
): Promise<{ meaningful: boolean; reason: string }> {
  const prompt = [
    "You are a content quality filter. Given a text snippet fetched from a URL, decide if it contains meaningful, indexable content.",
    "Answer with a JSON object: {\"meaningful\": true/false, \"reason\": \"one-sentence explanation\"}",
    "Meaningful = the page has substantive text content (article, documentation, blog post, product page, reference material, etc.).",
    "Not meaningful = login walls, cookie consent only, empty/placeholder pages, pure navigation, error pages, paywalls with no preview, redirect pages, or pages where the snippet has less than 50 words of actual content.",
    "",
    `URL: ${url}`,
    `Snippet (first ${MAX_CONTENT_CHARS} chars):`,
    snippet,
  ].join("\n");

  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_tokens: 150,
      response_format: { type: "json_object" },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI API error: ${res.status} ${text}`);
  }

  const data = (await res.json()) as {
    choices: Array<{ message: { content: string } }>;
  };

  const raw = data.choices?.[0]?.message?.content || "";

  try {
    const parsed = JSON.parse(raw) as { meaningful: boolean; reason: string };
    return {
      meaningful: Boolean(parsed.meaningful),
      reason: parsed.reason || "no reason given",
    };
  } catch {
    // If OpenAI response isn't valid JSON, default to meaningful (don't block ingestion)
    logger.warn(`[url-check] Could not parse OpenAI response for ${url}, defaulting to meaningful`);
    return { meaningful: true, reason: "parse error — defaulting to pass" };
  }
}

export async function checkUrl(
  url: string,
  apiKey: string,
  baseUrl = "https://api.openai.com/v1",
  model = OPENAI_DEFAULT_MODEL,
): Promise<UrlCheckResult> {
  const { ok, snippet, error } = await fetchSnippet(url);

  if (!ok) {
    return { url, reachable: false, meaningful: false, reason: error || "fetch failed" };
  }

  if (snippet.trim().length < 30) {
    return { url, reachable: true, meaningful: false, reason: "page returned almost no text content" };
  }

  const { meaningful, reason } = await askOpenAiMeaningful(snippet, url, apiKey, baseUrl, model);
  return { url, reachable: true, meaningful, reason };
}

export async function checkUrls(
  urls: string[],
  apiKey: string,
  baseUrl = "https://api.openai.com/v1",
  model = OPENAI_DEFAULT_MODEL,
  concurrency = 5,
): Promise<UrlCheckResult[]> {
  const results: UrlCheckResult[] = [];
  const queue = [...urls];
  let completed = 0;

  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const url = queue.shift();
      if (!url) break;

      const result = await checkUrl(url, apiKey, baseUrl, model);
      results.push(result);
      completed += 1;

      const icon = result.meaningful ? "✓" : "✗";
      const status = result.reachable ? (result.meaningful ? "pass" : "skip") : "unreachable";
      logger.info(
        `[url-check] ${icon} (${completed}/${urls.length}) [${status}] ${url} — ${result.reason}`,
      );
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, urls.length) }, () => worker());
  await Promise.all(workers);

  return results;
}
