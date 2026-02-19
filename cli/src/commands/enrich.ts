import type { Command } from "commander";
import { getEnrichmentStats, enqueueEnrichment, clearEnrichmentQueue } from "../lib/api-client.js";
import { getDefaultApiUrl } from "../lib/env.js";
import { logger } from "../lib/logger.js";
import type { EnrichmentStats } from "../lib/types.js";

interface EnrichOptions {
  api?: string;
  token?: string;
  collection?: string;
  force?: boolean;
  stats?: boolean;
  filter?: string;
  clear?: boolean;
}

export async function cmdEnrich(options: EnrichOptions): Promise<void> {
  const api = options.api || getDefaultApiUrl();
  const token = options.token;
  const collection = options.collection || "docs";
  const force = Boolean(options.force);
  const stats = Boolean(options.stats);
  const filter = (options.filter || "").trim();
  const clear = Boolean(options.clear);

  // Always show stats first (explicit behavior)
  const enrichmentStats = await getEnrichmentStats(api, collection, filter || undefined, token) as EnrichmentStats;
  
  logger.info("\n=== Enrichment Statistics ===");
  logger.info(`Queue:`);
  logger.info(`  Pending: ${enrichmentStats.queue.pending}`);
  logger.info(`  Processing: ${enrichmentStats.queue.processing}`);
  logger.info(`  Dead Letter: ${enrichmentStats.queue.deadLetter}`);
  logger.info(`\nTotals:`);
  logger.info(`  Enriched: ${enrichmentStats.totals.enriched}`);
  logger.info(`  Failed: ${enrichmentStats.totals.failed}`);
  logger.info(`  Pending: ${enrichmentStats.totals.pending}`);
  logger.info(`  Processing: ${enrichmentStats.totals.processing}`);
  logger.info(`  None: ${enrichmentStats.totals.none}`);
  logger.info("");

  if (stats) {
    // Only show stats, don't enqueue
    return;
  }

  if (clear) {
    const result = await clearEnrichmentQueue(api, collection, filter || undefined, token);
    if (filter) {
      logger.info(`[rag-index] Cleared ${result.cleared} queued tasks using full-text filter "${filter}".`);
    } else {
      logger.info(`[rag-index] Cleared ${result.cleared} queued enrichment tasks.`);
    }
    return;
  }

  // Enqueue enrichment tasks
  const result = await enqueueEnrichment(api, collection, force, filter || undefined, token);
  
  if (force && filter) {
    logger.info(
      `[rag-index] Re-enqueued ${result.enqueued} tasks (including already-enriched items) using full-text filter "${filter}".`
    );
  } else if (force) {
    logger.info(`[rag-index] Re-enqueued ${result.enqueued} tasks (including already-enriched items).`);
  } else if (filter) {
    logger.info(`[rag-index] Enqueued ${result.enqueued} pending tasks using full-text filter "${filter}".`);
  } else {
    logger.info(`[rag-index] Enqueued ${result.enqueued} pending tasks for enrichment.`);
  }
}

export function registerEnrichCommand(program: Command): void {
  program
    .command("enrich")
    .description("Trigger and monitor enrichment tasks")
    .option("--api <url>", "RAG API URL", getDefaultApiUrl())
    .option("--collection <name>", "Collection name", "docs")
    .option("--token <token>", "Bearer token for auth")
    .option("--force", "Re-enqueue all items (including already-enriched)", false)
    .option("--stats", "Show enrichment stats without enqueueing", false)
    .option("--filter <text>", "Full-text filter for selecting docs/chunks to re-enrich")
    .option("--clear", "Clear queued enrichment tasks (can be combined with --filter)", false)
    .action(cmdEnrich);
}
