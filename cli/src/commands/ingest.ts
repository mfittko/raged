import fs from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";
import { ingest } from "../lib/api-client.js";
import { getDefaultApiUrl } from "../lib/env.js";
import { logger } from "../lib/logger.js";
import { checkUrls } from "../lib/url-check.js";
import {
  listFiles,
  detectDocType,
  readFileContent,
  normalizePathForId,
  deriveIngestSource,
  LARGE_IMAGE_THRESHOLD_BYTES,
  DEFAULT_MAX_FILES,
  SUPPORTED_INGEST_EXTS,
} from "../lib/utils.js";
import type { IngestItem, IngestResponse } from "../lib/types.js";

interface IngestOptions {
  file?: string;
  dir?: string;
  url?: string;
  urlsFile?: string;
  api?: string;
  token?: string;
  collection?: string;
  maxFiles?: string;
  enrich?: boolean;
  overwrite?: boolean;
  docType?: string;
  ignore?: string;
  ignoreFile?: string;
  batchSize?: string;
  urlCheck?: boolean;
  urlCheckModel?: string;
}

function normalizeIgnorePattern(pattern: string): string {
  let value = pattern.trim().replace(/\\/g, "/");
  value = value.replace(/^\.\//, "");
  value = value.replace(/^\/+/, "");
  if (value.endsWith("/")) {
    value = `${value}**`;
  }
  return value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globPatternToRegExp(pattern: string): RegExp {
  let expression = "";
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    const next = pattern[index + 1];

    if (char === "*" && next === "*") {
      expression += ".*";
      index += 1;
      continue;
    }

    if (char === "*") {
      expression += "[^/]*";
      continue;
    }

    expression += escapeRegExp(char);
  }

  return new RegExp(`(^|/)${expression}$`);
}

async function loadIgnorePatterns(options: IngestOptions): Promise<string[]> {
  const patterns: string[] = [];

  const inline = (options.ignore || "")
    .split(",")
    .map((value) => normalizeIgnorePattern(value))
    .filter((value) => value.length > 0);
  patterns.push(...inline);

  if (options.ignoreFile) {
    const filePath = path.resolve(options.ignoreFile);
    const content = await fs.readFile(filePath, "utf8");
    const filePatterns = content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"))
      .map((line) => normalizeIgnorePattern(line))
      .filter((line) => line.length > 0);

    patterns.push(...filePatterns);
  }

  return patterns;
}

function parseIngestErrorStatus(error: unknown): number | null {
  if (!(error instanceof Error)) {
    return null;
  }

  const match = /^Ingest failed:\s*(\d+)\b/.exec(error.message);
  if (!match) {
    return null;
  }

  const status = Number.parseInt(match[1], 10);
  return Number.isFinite(status) ? status : null;
}

async function flushBatch(
  api: string,
  collection: string,
  token: string | undefined,
  enrich: boolean,
  overwrite: boolean,
  batchItems: IngestItem[],
): Promise<void> {
  if (batchItems.length === 0) {
    return;
  }

  try {
    await ingest(api, collection, batchItems, token, enrich, overwrite);
    return;
  } catch (error) {
    const status = parseIngestErrorStatus(error);

    if (status === 413 && batchItems.length > 1) {
      const mid = Math.ceil(batchItems.length / 2);
      logger.warn(
        `[rag-index] Batch too large (${batchItems.length} items). Retrying in smaller chunks.`
      );
      await flushBatch(api, collection, token, enrich, overwrite, batchItems.slice(0, mid));
      await flushBatch(api, collection, token, enrich, overwrite, batchItems.slice(mid));
      return;
    }

    if (batchItems.length > 1) {
      logger.warn(
        `[rag-index] Batch ingest failed for ${batchItems.length} items. Retrying each file individually.`
      );
      for (const item of batchItems) {
        await flushBatch(api, collection, token, enrich, overwrite, [item]);
      }
      return;
    }

    const item = batchItems[0];
    const source = String(item.source || item.id || "unknown");

    if (status === 413) {
      logger.error(
        `[rag-index] Skipping ${source}: request body too large (413). Consider increasing BODY_LIMIT_BYTES on the API or ingesting this file separately.`
      );
      return;
    }

    logger.error(`[rag-index] Failed to ingest ${source}:`, error);
  }
}

export async function cmdIngest(options: IngestOptions): Promise<void> {
  const api = options.api || getDefaultApiUrl();
  const token = options.token;
  const collection = options.collection || "docs";
  const file = options.file;
  const dir = options.dir;
  const url = options.url;
  const enrich = options.enrich !== false;
  const overwrite = options.overwrite === true;
  const docTypeOverride = options.docType;
  const maxFiles = Number(options.maxFiles || DEFAULT_MAX_FILES);
  const batchSize = Number(options.batchSize || "10");
  const rootDir = dir ? path.resolve(dir).replace(/\\/g, "/") : undefined;
  const ignorePatterns = await loadIgnorePatterns(options);
  const ignoreMatchers = ignorePatterns.map((pattern) => globPatternToRegExp(pattern));

  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    logger.error("Error: --batchSize must be a positive integer");
    process.exit(2);
  }

  const urlsFile = options.urlsFile;
  const urlCheck = options.urlCheck === true;
  const urlCheckModel = options.urlCheckModel || "gpt-4o-mini";

  // Check for mutual exclusion
  const inputCount = [file, dir, url, urlsFile].filter(Boolean).length;
  if (inputCount === 0) {
    logger.error("Error: --file, --dir, --url, or --urls-file is required");
    process.exit(2);
  }
  if (inputCount > 1) {
    logger.error("Error: --file, --dir, --url, and --urls-file are mutually exclusive");
    process.exit(2);
  }

  // Collect URLs from --url or --urls-file
  let urlsToIngest: string[] = [];

  if (url) {
    urlsToIngest = [url];
  } else if (urlsFile) {
    const filePath = path.resolve(urlsFile);
    const content = await fs.readFile(filePath, "utf8");
    urlsToIngest = content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));

    if (urlsToIngest.length === 0) {
      logger.error("Error: --urls-file contained no URLs");
      process.exit(2);
    }
    logger.info(`[rag-index] Loaded ${urlsToIngest.length} URLs from ${urlsFile}`);
  }

  // Handle URL ingestion (single or batch)
  if (urlsToIngest.length > 0) {
    // Optional URL content check via OpenAI
    if (urlCheck) {
      const openaiKey = process.env.OPENAI_API_KEY || "";
      if (!openaiKey) {
        logger.error("Error: --url-check requires OPENAI_API_KEY environment variable");
        process.exit(2);
      }

      const openaiBaseUrl = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
      logger.info(`[url-check] Checking ${urlsToIngest.length} URL(s) for meaningful content (model: ${urlCheckModel})...`);

      const checkResults = await checkUrls(urlsToIngest, openaiKey, openaiBaseUrl, urlCheckModel);
      const passed = checkResults.filter((r) => r.meaningful);
      const skipped = checkResults.filter((r) => !r.meaningful);

      logger.info(`[url-check] Results: ${passed.length} passed, ${skipped.length} skipped`);

      if (skipped.length > 0) {
        for (const r of skipped) {
          logger.warn(`[url-check] Skipped: ${r.url} — ${r.reason}`);
        }
      }

      urlsToIngest = passed.map((r) => r.url);

      if (urlsToIngest.length === 0) {
        logger.info("[url-check] No URLs passed content check. Nothing to ingest.");
        return;
      }
    }

    // Ingest URLs in batches
    let totalUpserted = 0;
    let totalErrors = 0;

    for (let i = 0; i < urlsToIngest.length; i += batchSize) {
      const batch = urlsToIngest.slice(i, i + batchSize);
      const batchItems: IngestItem[] = batch.map((u) => {
        const item: IngestItem = { url: u };
        if (docTypeOverride) item.docType = docTypeOverride;
        return item;
      });

      const batchNum = Math.floor(i / batchSize) + 1;
      const totalBatches = Math.ceil(urlsToIngest.length / batchSize);
      logger.info(`[rag-index] Ingesting URL batch ${batchNum}/${totalBatches} (${batch.length} URLs)...`);

      try {
        const result = await ingest(api, collection, batchItems, token, enrich, overwrite);

        if (result.errors && result.errors.length > 0) {
          for (const err of result.errors) {
            logger.error(`✗ Failed to ingest ${err.url} — ${err.reason}`);
          }
          totalErrors += result.errors.length;
        }

        totalUpserted += result.upserted;
      } catch (err) {
        logger.error(`✗ Batch ${batchNum} failed:`, err);
        totalErrors += batch.length;
      }
    }

    logger.info(`[rag-index] Done. Ingested ${totalUpserted} chunks from ${urlsToIngest.length} URL(s). Errors: ${totalErrors}`);

    if (totalUpserted === 0) {
      process.exit(1);
    }
    return;
  }

  const filesToProcess: string[] = [];
  
  if (file) {
    filesToProcess.push(file);
  } else if (dir) {
    // Pass maxFiles to listFiles for early-stop bounded traversal
    const allFiles = await listFiles(dir, maxFiles, {
      shouldIgnore(relativePath) {
        if (ignoreMatchers.length === 0) {
          return false;
        }
        const normalized = relativePath.replace(/\\/g, "/");
        return ignoreMatchers.some((matcher) => matcher.test(normalized));
      },
      shouldInclude(relativePath) {
        if (!docTypeOverride) {
          return true;
        }
        return detectDocType(relativePath) === docTypeOverride;
      },
    });
    filesToProcess.push(...allFiles);
    if (allFiles.length >= maxFiles) {
      logger.warn(`[rag-index] Warning: Reached matching file limit of ${maxFiles}, some files may be skipped (use --maxFiles to adjust)`);
    }
  }

  const items: IngestItem[] = [];
  let queuedForIngest = 0;
  let batchNumber = 0;
  
  for (const filePath of filesToProcess) {
    try {
      const detectedDocType = detectDocType(filePath);

      if (dir && docTypeOverride && detectedDocType !== docTypeOverride) {
        continue;
      }

      const docType = docTypeOverride || detectedDocType;
      
      // Skip unsupported file types when no override is provided
      if (!docTypeOverride && docType === "text") {
        const ext = path.extname(filePath).toLowerCase();
        
        if (ext && !SUPPORTED_INGEST_EXTS.has(ext)) {
          logger.warn(`[rag-index] Skipping unsupported file type (${ext}): ${filePath}`);
          continue;
        }
      }
      
      const { text, metadata = {}, rawData, rawMimeType } = await readFileContent(filePath, docType);
      
      // Warn about large images (check original file size from metadata)
      if (docType === "image" && typeof metadata.sizeBytes === "number" && metadata.sizeBytes > LARGE_IMAGE_THRESHOLD_BYTES) {
        logger.warn(`[rag-index] Warning: Large image file (${Math.round(metadata.sizeBytes / 1024)}KB) will be base64-encoded: ${filePath}`);
      }
      
      const fileName = path.basename(filePath);
      const relativePath = dir
        ? path.relative(dir, filePath).replace(/\\/g, "/")
        : undefined;
      const source = deriveIngestSource(filePath, {
        rootDir: dir,
        singleFile: Boolean(file),
      });
      const item: IngestItem = {
        id: `file:${normalizePathForId(filePath)}`,
        text,
        source,
        metadata: {
          ...metadata,
          fileName,
          filePath,
          ...(rootDir ? { rootDir } : {}),
          ...(relativePath ? { relativePath, path: relativePath } : {}),
        },
        docType,
      };

      if (rawData) {
        item.rawData = rawData;
      }

      if (rawMimeType) {
        item.rawMimeType = rawMimeType;
      }
      
      items.push(item);
      queuedForIngest += 1;
      
      if (items.length >= batchSize) {
        batchNumber += 1;
        const batchItems = items.splice(0, items.length);
        const batchStart = queuedForIngest - batchItems.length + 1;
        const batchEnd = queuedForIngest;
        const progressPct = Math.round((batchEnd / filesToProcess.length) * 100);
        logger.info(
          `[rag-index] Ingesting batch ${batchNumber} (${batchItems.length} files, ${batchStart}-${batchEnd}/${filesToProcess.length}, ${progressPct}%)...`
        );
        await flushBatch(api, collection, token, enrich, overwrite, batchItems);
      }
    } catch (err) {
      logger.error(`[rag-index] Error processing ${filePath}:`, err);
    }
  }

  if (items.length) {
    batchNumber += 1;
    const batchItems = items.splice(0, items.length);
    const batchStart = queuedForIngest - batchItems.length + 1;
    const batchEnd = queuedForIngest;
    const progressPct = Math.round((batchEnd / filesToProcess.length) * 100);
    logger.info(
      `[rag-index] Ingesting final batch ${batchNumber} (${batchItems.length} files, ${batchStart}-${batchEnd}/${filesToProcess.length}, ${progressPct}%)...`
    );
    await flushBatch(api, collection, token, enrich, overwrite, batchItems);
  }
  
  logger.info(`[rag-index] Done. Queued ${queuedForIngest}/${filesToProcess.length} files for ingestion.`);
}

export function registerIngestCommand(program: Command): void {
  program
    .command("ingest")
    .description("Ingest arbitrary files (PDFs, images, text)")
    .option("--file <path>", "Single file to ingest")
    .option("--dir <path>", "Directory to ingest")
    .option("--url <url>", "URL to fetch and ingest")
    .option("--api <url>", "RAG API URL", getDefaultApiUrl())
    .option("--collection <name>", "Collection name", "docs")
    .option("--token <token>", "Bearer token for auth")
    .option("--maxFiles <number>", "Maximum files to process from directory", String(DEFAULT_MAX_FILES))
    .option("--batchSize <number>", "Number of files to ingest per batch", "10")
    .option("--ignore <patterns>", "Comma-separated ignore patterns (e.g. tmp/**,**/*.tmp)")
    .option("--ignore-file <path>", "Path to file with ignore patterns (one per line)")
    .option("--no-enrich", "Disable enrichment")
    .option("--overwrite", "Overwrite existing documents for matching source/identity")
    .option("--doc-type <type>", "Override document type detection")
    .option("--urls-file <path>", "File containing URLs to ingest (one per line)")
    .option("--url-check", "Check each URL for meaningful content before ingesting (requires OPENAI_API_KEY)")
    .option("--url-check-model <model>", "OpenAI model for URL content check", "gpt-4o-mini")
    .action(cmdIngest);
}
