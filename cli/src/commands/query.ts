import type { Command } from "commander";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { downloadFirstQueryMatch, downloadFirstQueryMatchText, getCollections, query } from "../lib/api-client.js";
import { getDefaultApiUrl } from "../lib/env.js";
import { logger } from "../lib/logger.js";
import type { QueryResult } from "../lib/types.js";

interface QueryOptions {
  q?: string;
  query?: string;
  api?: string;
  token?: string;
  collection?: string;
  collections?: string;
  allCollections?: boolean;
  topK?: string;
  minScore?: string;
  summary?: boolean | string;
  keywords?: boolean;
  unique?: boolean;
  download?: boolean;
  full?: boolean;
  stdout?: boolean;
  open?: boolean;
  repoId?: string;
  pathPrefix?: string;
  lang?: string;
  positionalQuery?: string;
}

interface QueryPayload {
  payloadChecksum?: string | null;
  tier3Meta?: {
    keywords?: string[];
    key_entities?: string[];
  } | null;
  tier2Meta?: {
    keywords?: Array<{ text?: string } | string>;
  } | null;
  docSummary?: string | null;
  docSummaryShort?: string | null;
  docSummaryMedium?: string | null;
  docSummaryLong?: string | null;
}

interface QueryCommandDeps {
  openTargetFn?: (target: string) => void;
}

interface RankedQueryResult extends QueryResult {
  collection: string;
}

type SummaryLevel = "short" | "medium" | "long";

function getPayloadChecksum(result: QueryResult): string | null {
  const payload = (result as QueryResult & { payload?: QueryPayload }).payload;
  if (!payload || typeof payload.payloadChecksum !== "string") {
    return null;
  }

  const normalized = normalizeWhitespace(payload.payloadChecksum);
  return normalized.length > 0 ? normalized : null;
}

function deduplicateByChecksum(results: RankedQueryResult[]): RankedQueryResult[] {
  const seenChecksums = new Set<string>();
  const deduplicated: RankedQueryResult[] = [];

  for (const result of results) {
    const checksum = getPayloadChecksum(result);
    if (!checksum) {
      deduplicated.push(result);
      continue;
    }

    if (seenChecksums.has(checksum)) {
      continue;
    }

    seenChecksums.add(checksum);
    deduplicated.push(result);
  }

  return deduplicated;
}

function countQueryTerms(value: string): number {
  return normalizeWhitespace(value)
    .split(" ")
    .filter(term => term.length > 0).length;
}

function getAutoMinScore(queryText: string): number {
  const termCount = countQueryTerms(queryText);

  if (termCount <= 1) {
    return 0.3;
  }

  if (termCount === 2) {
    return 0.4;
  }

  if (termCount <= 4) {
    return 0.5;
  }

  return 0.6;
}

function resolveMinScore(minScoreOption: string | undefined, queryText: string): number {
  const normalized = String(minScoreOption ?? "auto").trim().toLowerCase();
  if (!normalized || normalized === "auto") {
    return getAutoMinScore(queryText);
  }

  const parsed = Number(normalized);
  if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1) {
    return parsed;
  }

  logger.warn(
    `Invalid --minScore value '${minScoreOption}'. It must be a number between 0 and 1 (inclusive); falling back to auto.`
  );
  return getAutoMinScore(queryText);
}

function parseCollectionsOption(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map(item => item.trim())
    .filter(item => item.length > 0);
}

function resolveSummaryLevel(value: boolean | string | undefined): SummaryLevel | null {
  if (value === undefined || value === false) {
    return null;
  }

  if (value === true) {
    return "medium";
  }

  const normalized = String(value).trim().toLowerCase();
  if (!normalized) {
    return "medium";
  }

  if (normalized === "short" || normalized === "medium" || normalized === "long") {
    return normalized;
  }

  logger.warn(`Unknown summary level '${value}', using 'medium'. Supported: short|medium|long.`);
  return "medium";
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function formatSummaryForOutput(result: QueryResult, summaryLevel: SummaryLevel): string | null {
  const payload = (result as QueryResult & { payload?: QueryPayload }).payload;

  const summaryCandidates: Array<string | null | undefined> =
    summaryLevel === "short"
      ? [payload?.docSummaryShort, payload?.docSummaryMedium, payload?.docSummary]
      : summaryLevel === "long"
        ? [payload?.docSummaryLong, payload?.docSummaryMedium, payload?.docSummary]
        : [payload?.docSummaryMedium, payload?.docSummary];

  const summary = summaryCandidates.find(candidate => typeof candidate === "string" && normalizeWhitespace(candidate).length > 0);
  if (!summary || typeof summary !== "string") {
    return null;
  }
  return normalizeWhitespace(summary);
}

function formatKeywordsForOutput(result: QueryResult): string[] {
  const payload = (result as QueryResult & { payload?: QueryPayload }).payload;
  const tier3Keywords = payload?.tier3Meta?.keywords;
  if (Array.isArray(tier3Keywords)) {
    const values = tier3Keywords.map(value => normalizeWhitespace(String(value))).filter(value => value.length > 0);
    if (values.length > 0) {
      return values;
    }
  }

  const keyEntities = payload?.tier3Meta?.key_entities;
  if (Array.isArray(keyEntities)) {
    const values = keyEntities.map(value => normalizeWhitespace(String(value))).filter(value => value.length > 0);
    if (values.length > 0) {
      return values;
    }
  }

  const tier2Keywords = payload?.tier2Meta?.keywords;
  if (Array.isArray(tier2Keywords)) {
    const values = tier2Keywords
      .map((value) => (typeof value === "string" ? value : String(value?.text ?? "")))
      .map(value => normalizeWhitespace(value))
      .filter(value => value.length > 0);
    if (values.length > 0) {
      return values;
    }
  }

  return [];
}

function looksLikeHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

async function writeDownloadFile(fileName: string, bytes: Buffer): Promise<string> {
  const downloadsDir = path.join(os.homedir(), "Downloads");
  const parsed = path.parse(fileName || "download.bin");
  const baseName = parsed.name || "download";
  const ext = parsed.ext || ".bin";

  let candidate = path.join(downloadsDir, `${baseName}${ext}`);
  let suffix = 1;

  while (true) {
    try {
      await fs.access(candidate);
      candidate = path.join(downloadsDir, `${baseName} (${suffix})${ext}`);
      suffix += 1;
    } catch {
      break;
    }
  }

  await fs.writeFile(candidate, bytes);
  return candidate;
}

async function writeOpenTempFile(fileName: string, bytes: Buffer): Promise<string> {
  const tempDir = path.join(os.tmpdir(), "raged-open");
  await fs.mkdir(tempDir, { recursive: true });

  const parsed = path.parse(fileName || "download.bin");
  const baseName = parsed.name || "download";
  const ext = parsed.ext || ".bin";
  let target = path.join(tempDir, `${baseName}${ext}`);
  let suffix = 1;

  while (true) {
    try {
      await fs.access(target);
      target = path.join(tempDir, `${baseName} (${suffix})${ext}`);
      suffix += 1;
    } catch {
      break;
    }
  }

  await fs.writeFile(target, bytes);
  return target;
}

async function writeTextDownloadFile(fileName: string, text: string): Promise<string> {
  const downloadsDir = path.join(os.homedir(), "Downloads");
  const parsed = path.parse(fileName || "download");
  const baseName = parsed.name || "download";

  let candidate = path.join(downloadsDir, `${baseName}.txt`);
  let suffix = 1;

  while (true) {
    try {
      await fs.access(candidate);
      candidate = path.join(downloadsDir, `${baseName} (${suffix}).txt`);
      suffix += 1;
    } catch {
      break;
    }
  }

  await fs.writeFile(candidate, text, "utf8");
  return candidate;
}

function openTarget(target: string): void {
  const opener = process.platform === "darwin"
    ? { command: "open", args: [target] }
    : process.platform === "win32"
      ? { command: "explorer", args: [target] }
      : { command: "xdg-open", args: [target] };

  const child = spawn(opener.command, opener.args, {
    stdio: "ignore",
    detached: true,
  });
  child.unref();
}

export async function cmdQuery(options: QueryOptions, deps: QueryCommandDeps = {}): Promise<void> {
  const api = options.api || getDefaultApiUrl();
  const token = options.token;
  const explicitCollection = options.collection?.trim();
  const explicitCollections = parseCollectionsOption(options.collections);
  const allCollections = options.allCollections === true;
  const q = options.q || options.query || options.positionalQuery;
  const queryText = String(q ?? "");
  const topK = Number(options.topK || 8);
  const minScore = resolveMinScore(options.minScore, queryText);
  const summaryLevel = resolveSummaryLevel(options.summary);
  const showKeywords = options.keywords === true;
  const uniqueByChecksum = options.unique === true;
  const shouldDownload = options.download === true;
  const shouldDownloadFullText = options.full === true;
  const shouldStdout = options.stdout === true;
  const shouldOpen = options.open === true;
  const openTargetFn = deps.openTargetFn ?? openTarget;
  const repoId = options.repoId;
  const pathPrefix = options.pathPrefix;
  const lang = options.lang;

  if (!q) {
    logger.error("Error: --q or --query is required");
    process.exit(2);
  }

  if (shouldStdout && !shouldDownloadFullText) {
    logger.warn("Ignoring --stdout because --full is not set.");
  }

  let targetCollections: string[];
  if (explicitCollections.length > 0) {
    targetCollections = explicitCollections;
  } else if (explicitCollection) {
    targetCollections = [explicitCollection];
  } else {
    targetCollections = ["docs"];
  }

  if (allCollections && explicitCollection) {
    logger.warn("Ignoring --collection because --allCollections is set.");
  }

  if (allCollections && explicitCollections.length > 0) {
    logger.warn("Ignoring --collections because --allCollections is set.");
  }

  if (allCollections) {
    try {
      const discovered = await getCollections(api, token);
      const discoveredNames = discovered
        .map(item => item.collection.trim())
        .filter(name => name.length > 0)
        .sort();
      targetCollections = discoveredNames.length > 0
        ? discoveredNames
        : ["docs"];
    } catch {
      logger.warn("Failed to auto-discover collections, falling back to default 'docs' collection.");
      targetCollections = ["docs"];
    }
  }

  // Build plain filter object for Postgres-backed API
  const filter: Record<string, string> = {};
  if (repoId) filter.repoId = repoId;
  if (pathPrefix) filter.path = pathPrefix;
  if (lang) filter.lang = lang;

  const scopedResults = await Promise.all(
    targetCollections.map(async (collectionName) => {
      const out = await query(api, collectionName, queryText, topK, minScore, Object.keys(filter).length > 0 ? filter : undefined, token);
      const results = (out?.results ?? []) as QueryResult[];
      return results.map((item) => ({ ...item, collection: collectionName })) as RankedQueryResult[];
    })
  );

  const rankedResults = scopedResults
    .flat()
    .sort((a, b) => b.score - a.score);

  const deduplicatedResults = uniqueByChecksum ? deduplicateByChecksum(rankedResults) : rankedResults;
  const results = deduplicatedResults.slice(0, topK);

  if (uniqueByChecksum) {
    const removed = rankedResults.length - deduplicatedResults.length;
    if (removed > 0) {
      logger.info(`Deduplicated ${removed} result(s) by payload checksum.`);
    }
  }

  if (!results.length) {
    logger.info("No results.");
    return;
  }

  if (!shouldDownload && !shouldDownloadFullText && !shouldOpen) {
    results.forEach((r: RankedQueryResult, i: number) => {
      const snippet = normalizeWhitespace(String(r.text ?? "")).slice(0, 280);
      const summary = summaryLevel ? formatSummaryForOutput(r, summaryLevel) : null;
      const keywords = showKeywords ? formatKeywordsForOutput(r) : [];
      logger.info(`#${i + 1}  score=${r.score}`);
      logger.info(`collection: ${r.collection}`);
      logger.info(`source: ${r.source}`);
      if (summaryLevel && summary) {
        logger.info(`summary: ${summary}`);
      } else if (summaryLevel) {
        logger.info(`snippet: ${snippet}`);
      } else {
        logger.info(snippet);
      }
      if (showKeywords && keywords.length > 0) {
        logger.info(`keywords: ${keywords.join(", ")}`);
      }
      logger.info("");
    });
    return;
  }

  const first = results[0];
  const firstSummary = summaryLevel ? formatSummaryForOutput(first, summaryLevel) : null;
  const firstKeywords = showKeywords ? formatKeywordsForOutput(first) : [];
  const firstSnippet = normalizeWhitespace(String(first.text ?? "")).slice(0, 280);
  const suppressPreviewOutput = shouldDownloadFullText && shouldStdout;
  if (!suppressPreviewOutput) {
    logger.info(`#1  score=${first.score}`);
    logger.info(`collection: ${first.collection}`);
    logger.info(`source: ${first.source}`);
    if (summaryLevel && firstSummary) {
      logger.info(`summary: ${firstSummary}`);
    } else if (summaryLevel) {
      logger.info(`snippet: ${firstSnippet}`);
    }
    if (showKeywords && firstKeywords.length > 0) {
      logger.info(`keywords: ${firstKeywords.join(", ")}`);
    }
  }

  let downloadedPath: string | null = null;
  const firstSource = String(first.source || "");

  if (shouldDownloadFullText) {
    const textDownload = await downloadFirstQueryMatchText(
      api,
      first.collection,
      queryText,
      topK,
      minScore,
      Object.keys(filter).length > 0 ? filter : undefined,
      token,
    );
    if (shouldStdout) {
      process.stdout.write(textDownload.text);
      if (!textDownload.text.endsWith("\n")) {
        process.stdout.write("\n");
      }
    } else {
      downloadedPath = await writeTextDownloadFile(textDownload.source || firstSource || "match", textDownload.text);
      logger.info(`Downloaded first match text to: ${downloadedPath}`);
    }
  } else if (shouldDownload || !looksLikeHttpUrl(firstSource)) {
    if (!shouldDownload && shouldOpen && !looksLikeHttpUrl(firstSource)) {
      logger.info("Opening a non-URL source requires a temporary download to open it locally.");
    }

    const download = await downloadFirstQueryMatch(
      api,
      first.collection,
      queryText,
      topK,
      minScore,
      Object.keys(filter).length > 0 ? filter : undefined,
      token,
    );

    downloadedPath = shouldDownload
      ? await writeDownloadFile(download.fileName, download.data)
      : await writeOpenTempFile(download.fileName, download.data);
    logger.info(`Downloaded first match to: ${downloadedPath}`);
  }

  if (shouldOpen) {
    if (downloadedPath) {
      openTargetFn(downloadedPath);
      logger.info(`Opened: ${downloadedPath}`);
    } else if (looksLikeHttpUrl(firstSource)) {
      openTargetFn(firstSource);
      logger.info(`Opened: ${firstSource}`);
    }
  }
}

export function registerQueryCommand(program: Command): void {
  program
    .command("query [queryText...]")
    .description("Search the RAG API for relevant chunks")
    .option("--q <text>", "Search query text")
    .option("--api <url>", "RAG API URL", getDefaultApiUrl())
    .option("--collection <name>", "Single collection name")
    .option("--collections <names>", "Comma-separated collection names")
    .option("--allCollections", "Search all discovered collections")
    .option("--topK <n>", "Number of results to return", "8")
    .option("--minScore <n|auto>", "Minimum similarity score cutoff (0-1) or 'auto' (default)", "auto")
    .option("--summary [level]", "Show LLM summary (short|medium|long). Defaults to medium when omitted")
    .option("--keywords", "Show extracted keywords when available")
    .option("--unique", "Deduplicate results by payload checksum across merged collections")
    .option("--full", "Download first match extracted text to ~/Downloads as .txt")
    .option("--stdout", "When used with --full, print extracted text to stdout instead of downloading")
    .option("--download", "Download first result raw file to ~/Downloads")
    .option("--open", "Open first result (URL directly, or by temp-downloading non-URL sources)")
    .option("--repoId <id>", "Filter by repository ID")
    .option("--pathPrefix <prefix>", "Filter by file path prefix")
    .option("--lang <lang>", "Filter by language")
    .option("--token <token>", "Bearer token for auth")
    .action((queryText: string[] | undefined, options: QueryOptions) => {
      const positional = Array.isArray(queryText) ? queryText.join(" ").trim() : "";
      return cmdQuery({
        ...options,
        positionalQuery: positional.length > 0 ? positional : undefined,
      });
    });
}
