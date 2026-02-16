import type { Command } from "commander";
import { query } from "../lib/api-client.js";
import { logger } from "../lib/logger.js";
import type { QueryResult } from "../lib/types.js";

interface QueryOptions {
  q?: string;
  query?: string;
  api?: string;
  token?: string;
  collection?: string;
  topK?: string;
  repoId?: string;
  pathPrefix?: string;
  lang?: string;
}

export async function cmdQuery(options: QueryOptions): Promise<void> {
  const api = options.api || "http://localhost:8080";
  const token = options.token;
  const collection = options.collection || "docs";
  const q = options.q || options.query;
  const topK = Number(options.topK || 8);
  const repoId = options.repoId;
  const pathPrefix = options.pathPrefix;
  const lang = options.lang;

  if (!q) {
    logger.error("Error: --q or --query is required");
    process.exit(2);
  }

  // Build plain filter object for Postgres-backed API
  const filter: Record<string, string> = {};
  if (repoId) filter.repoId = repoId;
  if (pathPrefix) filter.path = pathPrefix;
  if (lang) filter.lang = lang;

  const out = await query(api, collection, String(q), topK, Object.keys(filter).length > 0 ? filter : undefined, token);

  const results = (out?.results ?? []) as QueryResult[];
  if (!results.length) {
    logger.info("No results.");
    return;
  }

  results.forEach((r: QueryResult, i: number) => {
    const snippet = String(r.text ?? "").replace(/\s+/g, " ").slice(0, 280);
    logger.info(`#${i + 1}  score=${r.score}`);
    logger.info(`source: ${r.source}`);
    logger.info(snippet);
    logger.info("");
  });
}

export function registerQueryCommand(program: Command): void {
  program
    .command("query")
    .description("Search the RAG API for relevant chunks")
    .requiredOption("--q <text>", "Search query text")
    .option("--api <url>", "RAG API URL", "http://localhost:8080")
    .option("--collection <name>", "Collection name", "docs")
    .option("--topK <n>", "Number of results to return", "8")
    .option("--repoId <id>", "Filter by repository ID")
    .option("--pathPrefix <prefix>", "Filter by file path prefix")
    .option("--lang <lang>", "Filter by language")
    .option("--token <token>", "Bearer token for auth")
    .action(cmdQuery);
}
