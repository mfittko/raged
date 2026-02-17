import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { Command } from "commander";
import { ingest } from "../lib/api-client.js";
import { logger } from "../lib/logger.js";
import {
  run,
  listFiles,
  isTextLike,
  matchPrefix,
  extToLang,
} from "../lib/utils.js";
import type { IngestItem } from "../lib/types.js";

interface IndexOptions {
  repo: string;
  api?: string;
  token?: string;
  collection?: string;
  branch?: string;
  maxFiles?: string;
  maxBytes?: string;
  keep?: boolean;
  repoId?: string;
  enrich?: boolean;
  overwrite?: boolean;
  docType?: string;
  include?: string;
  exclude?: string;
}

export async function cmdIndex(options: IndexOptions): Promise<void> {
  const repoUrl = options.repo;
  const api = options.api || "http://localhost:8080";
  const token = options.token;
  const collection = options.collection || "docs";
  const branch = options.branch || "";
  const maxFiles = Number(options.maxFiles || 4000);
  const maxBytes = Number(options.maxBytes || 500_000);
  const keep = Boolean(options.keep);
  const repoId = String(options.repoId || repoUrl);
  const enrich = options.enrich !== false; // default true
  const overwrite = options.overwrite === true;
  const docType = options.docType;

  const includePrefix = options.include;
  const excludePrefix = options.exclude;

  if (!repoUrl) {
    logger.error("Error: --repo is required");
    process.exit(2);
  }

  // Validate numeric options
  if (!isFinite(maxFiles) || maxFiles <= 0) {
    logger.error(`Error: --maxFiles must be a positive number, got: ${options.maxFiles}`);
    process.exit(2);
  }
  
  if (!isFinite(maxBytes) || maxBytes <= 0) {
    logger.error(`Error: --maxBytes must be a positive number, got: ${options.maxBytes}`);
    process.exit(2);
  }

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rag-index-"));
  const repoDir = path.join(tmp, "repo");
  try {
    const cloneArgs = ["clone", "--depth", "1"];
    if (branch) cloneArgs.push("--branch", String(branch));
    cloneArgs.push(String(repoUrl), repoDir);

    logger.info(`[rag-index] Cloning ${repoUrl} ...`);
    await run("git", cloneArgs);

    logger.info(`[rag-index] Scanning files...`);
    const files = (await listFiles(repoDir)).slice(0, maxFiles);

    const items: IngestItem[] = [];
    for (const f of files) {
      if (!isTextLike(f)) continue;
      const rel = path.relative(repoDir, f).replace(/\\/g, "/");

      if (includePrefix && !matchPrefix(rel, includePrefix)) continue;
      if (excludePrefix && matchPrefix(rel, excludePrefix)) continue;

      const st = await fs.stat(f);
      if (st.size > maxBytes) continue;

      const text = await fs.readFile(f, "utf-8").catch(() => "");
      if (!text.trim()) continue;

      const item: IngestItem = {
        id: `${repoId}:${rel}`,
        text,
        source: `${repoUrl}#${rel}`,
        metadata: { repoId, repoUrl, path: rel, lang: extToLang(f), bytes: st.size },
      };
      
      if (docType) item.docType = docType;
      
      items.push(item);

      if (items.length >= 50) {
        logger.info(`[rag-index] Ingesting batch (${items.length})...`);
        await ingest(api, collection, items.splice(0, items.length), token, enrich, overwrite);
      }
    }

    if (items.length) {
      logger.info(`[rag-index] Ingesting final batch (${items.length})...`);
      await ingest(api, collection, items, token, enrich, overwrite);
    }
    logger.info(`[rag-index] Done. repoId=${repoId}`);
  } finally {
    if (keep) logger.info(`[rag-index] Kept temp dir: ${tmp}`);
    else await fs.rm(tmp, { recursive: true, force: true });
  }
}

export function registerIndexCommand(program: Command): void {
  program
    .command("index")
    .description("Clone a Git repository and index its files")
    .requiredOption("--repo <url>", "Git URL to clone")
    .option("--api <url>", "RAG API URL", "http://localhost:8080")
    .option("--collection <name>", "Collection name", "docs")
    .option("--branch <name>", "Git branch to clone")
    .option("--repoId <id>", "Stable identifier for this repo")
    .option("--token <token>", "Bearer token for auth")
    .option("--include <prefix>", "Only index files matching this path prefix")
    .option("--exclude <prefix>", "Skip files matching this path prefix")
    .option("--maxFiles <n>", "Maximum files to process", "4000")
    .option("--maxBytes <n>", "Maximum file size in bytes", "500000")
    .option("--keep", "Keep the cloned temp directory", false)
    .option("--no-enrich", "Disable enrichment")
    .option("--overwrite", "Overwrite existing documents for matching source/identity")
    .option("--doc-type <type>", "Override document type detection")
    .action(cmdIndex);
}
