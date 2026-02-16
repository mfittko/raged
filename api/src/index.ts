import { buildApp } from "./server.js";
import { runMigrations } from "./db.js";

const PORT = Number(process.env.PORT || "8080");
const app = buildApp();

/**
 * Validate required configuration at startup.
 * Exits with clear error messages if critical config is missing.
 */
function validateConfig() {
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

  if (errors.length > 0) {
    app.log.error("Configuration validation failed:");
    errors.forEach((error) => app.log.error(`  - ${error}`));
    process.exit(1);
  }

  app.log.info("Configuration validation passed");
}

// Run database migrations on startup
async function init() {
  validateConfig();
  
  try {
    await runMigrations({ log: (message) => app.log.info(message) });
    app.log.info("Database migrations completed");
  } catch (err) {
    app.log.error({ err }, "Failed to run database migrations");
    throw err;
  }
}

init()
  .then(() => app.listen({ port: PORT, host: "0.0.0.0" }))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
