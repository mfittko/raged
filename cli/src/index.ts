#!/usr/bin/env node
import { Command } from "commander";
import { registerIndexCommand } from "./commands/index.js";
import { registerQueryCommand } from "./commands/query.js";
import { registerIngestCommand } from "./commands/ingest.js";
import { registerEnrichCommand } from "./commands/enrich.js";
import { registerGraphCommand } from "./commands/graph.js";
import { registerCollectionsCommand } from "./commands/collections.js";
import { loadDotEnvFromCwd } from "./lib/env.js";

async function main() {
  await loadDotEnvFromCwd();

  const program = new Command();
  
  program
    .name("raged")
    .description("CLI tool for indexing repositories and querying the RAG API")
    .version("1.0.0");

  // Register all commands
  registerIndexCommand(program);
  registerQueryCommand(program);
  registerIngestCommand(program);
  registerEnrichCommand(program);
  registerGraphCommand(program);
  registerCollectionsCommand(program);

  await program.parseAsync(process.argv);
}

main().catch((e) => { console.error(e); process.exit(1); });
