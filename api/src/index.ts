import { buildApp } from "./server.js";
import { runMigrations } from "./db.js";

const PORT = Number(process.env.PORT || "8080");
const app = buildApp();

// Run database migrations on startup
async function init() {
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
