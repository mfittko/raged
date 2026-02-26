import type { Command } from "commander";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { downloadFirstQueryMatch, downloadFirstQueryMatchText, getCollections, query } from "../lib/api-client.js";
import { getDefaultApiUrl } from "../lib/env.js";
import { logger } from "../lib/logger.js";
import type { QueryResultItem, CliFilterCondition, CliFilterDSL, QueryResponse } from "../lib/types.js";

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
  since?: string;
  until?: string;
  filterField?: string[];
  filterCombine?: string;
  strategy?: string;
  verbose?: boolean;
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

interface RankedQueryResult extends QueryResultItem {
  collection: string;
  routing?: import("../lib/types.js").RoutingDecision;
}

/** Per-collection query response including graph and routing data. */
interface CollectionQueryResponse extends QueryResponse {
  collection: string;
}

type SummaryLevel = "short" | "medium" | "long";

function getPayloadChecksum(result: QueryResultItem): string | null {
  const payload = (result as QueryResultItem & { payload?: QueryPayload }).payload;
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

function formatSummaryForOutput(result: QueryResultItem, summaryLevel: SummaryLevel): string | null {
  const payload = (result as QueryResultItem & { payload?: QueryPayload }).payload;

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

function formatKeywordsForOutput(result: QueryResultItem): string[] {
  const payload = (result as QueryResultItem & { payload?: QueryPayload }).payload;
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

/**
 * Resolves a temporal shorthand to an ISO 8601 string.
 *
 * Supported shorthands:
 *   today        → start of today in local timezone, returned as UTC ISO 8601
 *   yesterday    → start of yesterday in local timezone, returned as UTC ISO 8601
 *   <N>d         → now minus N days
 *   <N>y         → now minus N years
 *   ISO 8601     → passed through unchanged
 */
export function resolveTemporalShorthand(value: string): string {
  const normalized = value.trim();

  if (normalized === "today") {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.toISOString();
  }

  if (normalized === "yesterday") {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    d.setHours(0, 0, 0, 0);
    return d.toISOString();
  }

  const daysMatch = /^(\d+)d$/i.exec(normalized);
  if (daysMatch) {
    const days = parseInt(daysMatch[1], 10);
    const d = new Date();
    d.setDate(d.getDate() - days);
    return d.toISOString();
  }

  const yearsMatch = /^(\d+)y$/i.exec(normalized);
  if (yearsMatch) {
    const years = parseInt(yearsMatch[1], 10);
    const d = new Date();
    d.setFullYear(d.getFullYear() - years);
    return d.toISOString();
  }

  // Validate that it looks like an ISO 8601 date/datetime
  if (/^\d{4}-\d{2}-\d{2}/.test(normalized)) {
    return normalized;
  }

  throw new Error(`Unrecognized temporal value: "${value}". Expected today, yesterday, <N>d, <N>y, or ISO 8601 date.`);
}

/**
 * Parses a --filterField token into a CliFilterCondition.
 *
 * Supported formats:
 *   field:op:value              → single value (eq, ne, gt, gte, lt, lte)
 *   field:op                    → no-value operators (isNull, isNotNull)
 *   field:in:val1,val2,...      → comma-separated list for in/notIn
 *   field:between:low,high      → comma-separated low,high for between/notBetween
 */
export function parseFilterField(token: string): CliFilterCondition {
  const firstColon = token.indexOf(":");
  if (firstColon === -1) {
    throw new Error(`Invalid --filterField "${token}": expected format field:op:value or field:op`);
  }

  const field = token.slice(0, firstColon);
  const rest = token.slice(firstColon + 1);
  const secondColon = rest.indexOf(":");
  const noValueOps = new Set(["isNull", "isNotNull"]);
  const arrayOps = new Set(["in", "notIn"]);
  const rangeOps = new Set(["between", "notBetween"]);

  if (secondColon === -1) {
    const op = rest;
    if (!noValueOps.has(op)) {
      throw new Error(`Invalid --filterField "${token}": operator "${op}" requires a value`);
    }
    return { field, op };
  }

  const op = rest.slice(0, secondColon);
  const rawValue = rest.slice(secondColon + 1);

  if (arrayOps.has(op)) {
    const values = rawValue.split(",").map((v) => v.trim()).filter((v) => v.length > 0);
    if (values.length === 0) {
      throw new Error(`Invalid --filterField "${token}": operator "${op}" requires at least one value`);
    }
    return { field, op, values };
  }

  if (rangeOps.has(op)) {
    const parts = rawValue.split(",");
    if (parts.length < 2) {
      throw new Error(`Invalid --filterField "${token}": operator "${op}" requires format low,high`);
    }
    const low = parts[0].trim();
    const high = parts.slice(1).join(",").trim();
    return { field, op, range: { low, high } };
  }

  return { field, op, value: rawValue };
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

function formatRoutingLine(routing: import("../lib/types.js").RoutingDecision): string {
  return `routing: ${routing.strategy}  (${routing.method}, ${routing.durationMs}ms)`;
}

function formatFilterMatch(effectiveFilter: Record<string, unknown> | import("../lib/types.js").CliFilterDSL | undefined): string {
  if (!effectiveFilter) return "filter match: (none)";

  const dsl = effectiveFilter as import("../lib/types.js").CliFilterDSL;
  if (dsl.conditions && Array.isArray(dsl.conditions)) {
    const pairs = dsl.conditions.map((c: import("../lib/types.js").CliFilterCondition) => {
      if (c.op === "eq" || c.op === "gte" || c.op === "lte" || c.op === "gt" || c.op === "lt" || c.op === "ne") {
        return c.op === "eq" ? `${c.field}=${c.value}` : `${c.field} ${c.op} ${c.value}`;
      }
      if (c.op === "in" && c.values) return `${c.field} in [${c.values.join(",")}]`;
      if (c.op === "notIn" && c.values) return `${c.field} notIn [${c.values.join(",")}]`;
      if ((c.op === "between" || c.op === "notBetween") && c.range) return `${c.field} ${c.op} ${c.range.low},${c.range.high}`;
      return `${c.field} ${c.op}`;
    });
    return `filter match: ${pairs.join(", ")}`;
  }

  // Legacy key-value filter
  const kv = Object.entries(effectiveFilter as Record<string, unknown>)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${String(v)}`);
  return kv.length > 0 ? `filter match: ${kv.join(", ")}` : "filter match: (none)";
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

  const strategy = options.strategy;
  const verbose = options.verbose === true;

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

  // Build DSL filter conditions from --since, --until, and --filterField flags
  const dslConditions: CliFilterCondition[] = [];

  if (options.since !== undefined) {
    let resolvedSince: string;
    try {
      resolvedSince = resolveTemporalShorthand(options.since);
    } catch (e) {
      logger.error(String(e instanceof Error ? e.message : e));
      process.exit(2);
    }
    dslConditions.push({ field: "ingestedAt", op: "gte", value: resolvedSince, alias: "d" });
  }

  if (options.until !== undefined) {
    let resolvedUntil: string;
    try {
      resolvedUntil = resolveTemporalShorthand(options.until);
    } catch (e) {
      logger.error(String(e instanceof Error ? e.message : e));
      process.exit(2);
    }
    dslConditions.push({ field: "ingestedAt", op: "lte", value: resolvedUntil, alias: "d" });
  }

  if (options.filterField && options.filterField.length > 0) {
    for (const token of options.filterField) {
      let cond: CliFilterCondition;
      try {
        cond = parseFilterField(token);
      } catch (e) {
        logger.error(String(e instanceof Error ? e.message : e));
        process.exit(2);
      }
      dslConditions.push(cond);
    }
  }

  // Determine the effective filter to send: DSL takes precedence over legacy plain filter
  let effectiveFilter: Record<string, unknown> | CliFilterDSL | undefined;
  if (dslConditions.length > 0) {
    if (Object.keys(filter).length > 0) {
      logger.warn("--repoId, --pathPrefix, and --lang are ignored when --since, --until, or --filterField is provided. Use --filterField to combine all filters.");
    }
    if (options.filterCombine !== undefined && options.filterCombine !== "and" && options.filterCombine !== "or") {
      logger.error(`Invalid --filterCombine value "${options.filterCombine}". Expected "and" or "or".`);
      process.exit(2);
    }
    const combine = options.filterCombine === "or" ? "or" : "and";
    const dsl: CliFilterDSL = { conditions: dslConditions, combine };
    effectiveFilter = dsl as unknown as Record<string, unknown>;
  } else if (Object.keys(filter).length > 0) {
    effectiveFilter = filter;
  }

  const scopedResponses = await Promise.all(
    targetCollections.map(async (collectionName) => {
      const out = await query(api, collectionName, queryText, topK, minScore, effectiveFilter as Record<string, unknown> | undefined, strategy, token);
      const items = (out?.results ?? []) as QueryResultItem[];
      const results = items.map((item) => ({ ...item, collection: collectionName, routing: out.routing })) as RankedQueryResult[];
      return { results, collection: collectionName, routing: out.routing, graph: out.graph } as CollectionQueryResponse & { results: RankedQueryResult[] };
    })
  );

  const scopedResults = scopedResponses.map(r => r.results);

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
    // Collect graph documents from all collection responses for display after results
    const allGraphDocuments = scopedResponses.flatMap(resp =>
      resp.graph?.documents ? resp.graph.documents.map(d => ({ ...d, _collectionStrategy: resp.routing?.strategy })) : []
    );

    results.forEach((r: RankedQueryResult, i: number) => {
      const resultStrategy = r.routing?.strategy ?? "semantic";
      const snippet = normalizeWhitespace(String(r.text ?? "")).slice(0, 280);
      const summary = summaryLevel ? formatSummaryForOutput(r, summaryLevel) : null;
      const keywords = showKeywords ? formatKeywordsForOutput(r) : [];
      logger.info(`#${i + 1}  score=${r.score}`);
      logger.info(`collection: ${r.collection}`);
      logger.info(`source: ${r.source}`);
      // Show routing line for non-semantic strategies, or when --verbose
      if (r.routing && (resultStrategy !== "semantic" || verbose)) {
        logger.info(formatRoutingLine(r.routing));
      }
      // Per-strategy display
      if (resultStrategy === "metadata" && r.score === 1.0) {
        logger.info(formatFilterMatch(effectiveFilter));
      } else if (summaryLevel && summary) {
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

    // Show graph documents section when graph.documents is present
    if (allGraphDocuments.length > 0) {
      logger.info(`--- graph documents (${allGraphDocuments.length}) ---`);
      allGraphDocuments.forEach((doc, i) => {
        logger.info(`[G${i + 1}]  ${doc.source}`);
      });
    }
    return;
  }

  const first = results[0];
  const firstStrategy = first.routing?.strategy ?? "semantic";
  const firstSummary = summaryLevel ? formatSummaryForOutput(first, summaryLevel) : null;
  const firstKeywords = showKeywords ? formatKeywordsForOutput(first) : [];
  const firstSnippet = normalizeWhitespace(String(first.text ?? "")).slice(0, 280);
  const suppressPreviewOutput = shouldDownloadFullText && shouldStdout;
  if (!suppressPreviewOutput) {
    logger.info(`#1  score=${first.score}`);
    logger.info(`collection: ${first.collection}`);
    logger.info(`source: ${first.source}`);
    if (first.routing && (firstStrategy !== "semantic" || verbose)) {
      logger.info(formatRoutingLine(first.routing));
    }
    if (firstStrategy === "metadata" && first.score === 1.0) {
      logger.info(formatFilterMatch(effectiveFilter));
    } else if (summaryLevel && firstSummary) {
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
      effectiveFilter as Record<string, unknown> | undefined,
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
      effectiveFilter as Record<string, unknown> | undefined,
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
    .option("--since <value>", "Temporal lower bound for ingestedAt (today, yesterday, <N>d, <N>y, or ISO 8601)")
    .option("--until <value>", "Temporal upper bound for ingestedAt (today, yesterday, <N>d, <N>y, or ISO 8601)")
    .option("--filterField <f:op:v>", "Structured filter condition (repeatable). Format: field:op:value or field:op", (val, prev: string[]) => [...(prev ?? []), val], [] as string[])
    .option("--filterCombine <and|or>", "How to join --filterField conditions (default: and)")
    .option("--strategy <name>", "Force query strategy: semantic, metadata, graph, hybrid (default: auto)")
    .option("--verbose", "Always print routing decision and timing for all results")
    .option("--token <token>", "Bearer token for auth")
    .action((queryText: string[] | undefined, options: QueryOptions) => {
      const positional = Array.isArray(queryText) ? queryText.join(" ").trim() : "";
      return cmdQuery({
        ...options,
        positionalQuery: positional.length > 0 ? positional : undefined,
      });
    });
}
