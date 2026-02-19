import type { Command } from "commander";
import { getCollections } from "../lib/api-client.js";
import { getDefaultApiUrl } from "../lib/env.js";
import { logger } from "../lib/logger.js";

interface CollectionsOptions {
  api?: string;
  token?: string;
  json?: boolean;
}

export async function cmdCollections(options: CollectionsOptions): Promise<void> {
  const api = options.api || getDefaultApiUrl();
  const token = options.token;
  const asJson = options.json === true;

  const collections = await getCollections(api, token);
  if (asJson) {
    logger.info(JSON.stringify({ collections }, null, 2));
    return;
  }

  if (collections.length === 0) {
    logger.info("No collections found.");
    return;
  }

  for (const entry of collections) {
    logger.info(
      `${entry.collection}  docs=${entry.documentCount}  chunks=${entry.chunkCount}  enriched=${entry.enrichedChunkCount}`
    );
  }
}

export function registerCollectionsCommand(program: Command): void {
  program
    .command("collections")
    .description("List collections with document/chunk stats")
    .option("--api <url>", "RAG API URL", getDefaultApiUrl())
    .option("--token <token>", "Bearer token for auth")
    .option("--json", "Output JSON")
    .action((options: CollectionsOptions) => cmdCollections(options));
}
