import type { Command } from "commander";
import { getGraphEntity } from "../lib/api-client.js";
import { logger } from "../lib/logger.js";
import type { GraphEntityResponse } from "../lib/types.js";

interface GraphOptions {
  entity?: string;
  api?: string;
  token?: string;
}

export async function cmdGraph(options: GraphOptions): Promise<void> {
  const api = options.api || "http://localhost:8080";
  const token = options.token;
  const entity = options.entity;

  if (!entity) {
    logger.error("Error: --entity is required");
    process.exit(2);
  }

  const data = await getGraphEntity(api, entity, token);

  if (!data) {
    logger.info(`Entity "${entity}" not found in the knowledge graph.`);
    return;
  }

  const entityData = data as GraphEntityResponse;
  
  logger.info(`\n=== Entity: ${entityData.entity.name} ===`);
  logger.info(`Type: ${entityData.entity.type}`);
  if (entityData.entity.description) {
    logger.info(`Description: ${entityData.entity.description}`);
  }
  
  if (entityData.connections && entityData.connections.length > 0) {
    logger.info(`\n=== Connections (${entityData.connections.length}) ===`);
    entityData.connections.forEach((conn) => {
      const arrow = conn.direction === "outgoing" ? "→" : "←";
      logger.info(`  ${arrow} ${conn.entity} (${conn.relationship})`);
    });
  }
  
  if (entityData.documents && entityData.documents.length > 0) {
    logger.info(`\n=== Related Documents (${entityData.documents.length}) ===`);
    entityData.documents.slice(0, 10).forEach((doc) => {
      logger.info(`  - ${doc.id}`);
    });
    if (entityData.documents.length > 10) {
      logger.info(`  ... and ${entityData.documents.length - 10} more`);
    }
  }
  logger.info("");
}

export function registerGraphCommand(program: Command): void {
  program
    .command("graph")
    .description("Query the knowledge graph for entity information")
    .requiredOption("--entity <name>", "Entity name to look up")
    .option("--api <url>", "RAG API URL", "http://localhost:8080")
    .option("--token <token>", "Bearer token for auth")
    .action(cmdGraph);
}
