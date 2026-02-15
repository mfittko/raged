import type { Command } from "commander";
import { getEnrichmentStats, enqueueEnrichment } from "../lib/api-client.js";
import { logger } from "../lib/logger.js";
import type { EnrichmentStats } from "../lib/types.js";

interface EnrichOptions {
  api?: string;
  token?: string;
  collection?: string;
  force?: boolean;
  statsOnly?: boolean;
}

export async function cmdEnrich(options: EnrichOptions): Promise<void> {
  const api = options.api || "http://localhost:8080";
  const token = options.token;
  const collection = options.collection || "docs";
  const force = Boolean(options.force);
  const statsOnly = Boolean(options.statsOnly);

  // Always show stats first (explicit behavior)
  const stats = await getEnrichmentStats(api, token) as EnrichmentStats;
  
  logger.info("\n=== Enrichment Statistics ===");
  logger.info(`Queue:`);
  logger.info(`  Pending: ${stats.queue.pending}`);
  logger.info(`  Processing: ${stats.queue.processing}`);
  logger.info(`  Dead Letter: ${stats.queue.deadLetter}`);
  logger.info(`\nTotals:`);
  logger.info(`  Enriched: ${stats.totals.enriched}`);
  logger.info(`  Failed: ${stats.totals.failed}`);
  logger.info(`  Pending: ${stats.totals.pending}`);
  logger.info(`  Processing: ${stats.totals.processing}`);
  logger.info(`  None: ${stats.totals.none}`);
  logger.info("");

  if (statsOnly) {
    // Only show stats, don't enqueue
    return;
  }

  // Enqueue enrichment tasks
  const result = await enqueueEnrichment(api, collection, force, token);
  
  if (force) {
    logger.info(`[rag-index] Re-enqueued ${result.enqueued} tasks (including already-enriched items).`);
  } else {
    logger.info(`[rag-index] Enqueued ${result.enqueued} pending tasks for enrichment.`);
  }
}

export function registerEnrichCommand(program: Command): void {
  program
    .command("enrich")
    .description("Trigger and monitor enrichment tasks")
    .option("--api <url>", "RAG API URL", "http://localhost:8080")
    .option("--collection <name>", "Qdrant collection name", "docs")
    .option("--token <token>", "Bearer token for auth")
    .option("--force", "Re-enqueue all items (including already-enriched)", false)
    .option("--stats-only", "Show enrichment stats without enqueueing", false)
    .action(cmdEnrich);
}
