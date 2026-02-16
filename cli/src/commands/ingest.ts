import path from "node:path";
import type { Command } from "commander";
import { ingest } from "../lib/api-client.js";
import { logger } from "../lib/logger.js";
import {
  listFiles,
  detectDocType,
  readFileContent,
  normalizePathForId,
  LARGE_IMAGE_THRESHOLD_BYTES,
  DEFAULT_MAX_FILES,
  SUPPORTED_INGEST_EXTS,
} from "../lib/utils.js";
import type { IngestItem, IngestResponse } from "../lib/types.js";

interface IngestOptions {
  file?: string;
  dir?: string;
  url?: string;
  api?: string;
  token?: string;
  collection?: string;
  maxFiles?: string;
  enrich?: boolean;
  docType?: string;
}

export async function cmdIngest(options: IngestOptions): Promise<void> {
  const api = options.api || "http://localhost:8080";
  const token = options.token;
  const collection = options.collection || "docs";
  const file = options.file;
  const dir = options.dir;
  const url = options.url;
  const enrich = options.enrich !== false;
  const docTypeOverride = options.docType;
  const maxFiles = Number(options.maxFiles || DEFAULT_MAX_FILES);

  // Check for mutual exclusion
  const inputCount = [file, dir, url].filter(Boolean).length;
  if (inputCount === 0) {
    logger.error("Error: --file, --dir, or --url is required");
    process.exit(2);
  }
  if (inputCount > 1) {
    logger.error("Error: --file, --dir, and --url are mutually exclusive");
    process.exit(2);
  }

  // Handle URL ingestion
  if (url) {
    logger.info(`Fetching ${url} ...`);
    const item: IngestItem = { url };
    if (docTypeOverride) item.docType = docTypeOverride;

    try {
      const result = await ingest(api, collection, [item], token, enrich);
      
      if (result.errors && result.errors.length > 0) {
        for (const err of result.errors) {
          logger.error(`✗ Failed to ingest ${err.url} — ${err.reason}`);
        }
        // Exit with error status if ingestion failed
        if (result.upserted === 0) {
          process.exit(1);
        }
      }
      
      if (result.upserted > 0) {
        const docTypeLabel = docTypeOverride || "unknown";
        logger.info(`✓ Ingested ${result.upserted} chunks from ${url} (${docTypeLabel})`);
      }
      
      if (result.upserted === 0 && (!result.errors || result.errors.length === 0)) {
        logger.info(`✗ No content ingested from ${url}`);
        process.exit(1);
      }
    } catch (err) {
      logger.error(`✗ Failed to ingest ${url}:`, err);
      process.exit(1);
    }
    return;
  }

  const filesToProcess: string[] = [];
  
  if (file) {
    filesToProcess.push(file);
  } else if (dir) {
    // Pass maxFiles to listFiles for early-stop bounded traversal
    const allFiles = await listFiles(dir, maxFiles);
    filesToProcess.push(...allFiles);
    if (allFiles.length >= maxFiles) {
      logger.warn(`[rag-index] Warning: Reached file limit of ${maxFiles}, some files may be skipped (use --maxFiles to adjust)`);
    }
  }

  const items: IngestItem[] = [];
  
  for (const filePath of filesToProcess) {
    try {
      const docType = docTypeOverride || detectDocType(filePath);
      
      // Skip unsupported file types when no override is provided
      if (!docTypeOverride && docType === "text") {
        const ext = path.extname(filePath).toLowerCase();
        
        if (ext && !SUPPORTED_INGEST_EXTS.has(ext)) {
          logger.warn(`[rag-index] Skipping unsupported file type (${ext}): ${filePath}`);
          continue;
        }
      }
      
      const { text, metadata = {} } = await readFileContent(filePath, docType);
      
      // Warn about large images (check original file size from metadata)
      if (docType === "image" && typeof metadata.sizeBytes === "number" && metadata.sizeBytes > LARGE_IMAGE_THRESHOLD_BYTES) {
        logger.warn(`[rag-index] Warning: Large image file (${Math.round(metadata.sizeBytes / 1024)}KB) will be base64-encoded: ${filePath}`);
      }
      
      const fileName = path.basename(filePath);
      const item: IngestItem = {
        id: `file:${normalizePathForId(filePath)}`,
        text,
        source: filePath,
        metadata: { ...metadata, fileName, filePath },
        docType,
      };
      
      items.push(item);
      
      if (items.length >= 10) {
        logger.info(`[rag-index] Ingesting batch (${items.length})...`);
        await ingest(api, collection, items.splice(0, items.length), token, enrich);
      }
    } catch (err) {
      logger.error(`[rag-index] Error processing ${filePath}:`, err);
    }
  }

  if (items.length) {
    logger.info(`[rag-index] Ingesting final batch (${items.length})...`);
    await ingest(api, collection, items, token, enrich);
  }
  
  logger.info(`[rag-index] Done. Processed ${filesToProcess.length} files.`);
}

export function registerIngestCommand(program: Command): void {
  program
    .command("ingest")
    .description("Ingest arbitrary files (PDFs, images, text)")
    .option("--file <path>", "Single file to ingest")
    .option("--dir <path>", "Directory to ingest")
    .option("--url <url>", "URL to fetch and ingest")
    .option("--api <url>", "RAG API URL", "http://localhost:8080")
    .option("--collection <name>", "Collection name", "docs")
    .option("--token <token>", "Bearer token for auth")
    .option("--maxFiles <number>", "Maximum files to process from directory", String(DEFAULT_MAX_FILES))
    .option("--no-enrich", "Disable enrichment")
    .option("--doc-type <type>", "Override document type detection")
    .action(cmdIngest);
}
