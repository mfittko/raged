import { buildApp } from "./server.js";
import { runMigrations } from "./db.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PORT = Number(process.env.PORT || "8080");

/**
 * Validate required configuration.
 * Returns an array of error messages, or empty array if valid.
 */
export function validateConfig(): string[] {
  const errors: string[] = [];

  // DATABASE_URL is required (unless ALLOW_DEV_DB is set for local dev)
  if (!process.env.DATABASE_URL && process.env.ALLOW_DEV_DB !== "true") {
    errors.push("DATABASE_URL is required. Set DATABASE_URL or set ALLOW_DEV_DB=true for local development.");
  }

  // OLLAMA_URL is required for embedding generation
  if (!process.env.OLLAMA_URL) {
    errors.push("OLLAMA_URL is required for embedding generation (e.g., http://localhost:11434)");
  }

  // QDRANT_URL is required while legacy vector path is active
  if (!process.env.QDRANT_URL) {
    errors.push("QDRANT_URL is required for vector storage (e.g., http://localhost:6333)");
  }

  return errors;
}

// Run database migrations on startup
async function init() {
  const app = buildApp();
  
  const configErrors = validateConfig();
  if (configErrors.length > 0) {
    app.log.error("Configuration validation failed:");
    configErrors.forEach((error) => app.log.error(`  - ${error}`));
    process.exit(1);
  }

  app.log.info("Configuration validation passed");
  
  try {
    await runMigrations({ log: (message) => app.log.info(message) });
    app.log.info("Database migrations completed");
  } catch (err) {
    app.log.error({ err }, "Failed to run database migrations");
    throw err;
  }
  
  return app;
}

// Only run when this file is executed directly
const entrypointPath = process.argv[1] ? path.resolve(process.argv[1]) : "";

if (entrypointPath && fileURLToPath(import.meta.url) === entrypointPath) {
  init()
    .then((app) => app.listen({ port: PORT, host: "0.0.0.0" }))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
