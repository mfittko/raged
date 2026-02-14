import { buildApp } from "./server.js";
import { ensureIndexes, isGraphEnabled } from "./graph-client.js";

const PORT = Number(process.env.PORT || "8080");
const app = buildApp();

// Initialize database indexes on startup
async function init() {
  if (isGraphEnabled()) {
    try {
      await ensureIndexes();
      app.log.info("Neo4j indexes ensured");
    } catch (err) {
      app.log.warn({ err }, "Failed to ensure Neo4j indexes");
    }
  }
}

init()
  .then(() => app.listen({ port: PORT, host: "0.0.0.0" }))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
