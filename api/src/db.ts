import pg from "pg";
import { readFile } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const { Pool } = pg;

function getDatabaseUrl(): string | undefined {
  return (
    process.env.DATABASE_URL ??
    (process.env.ALLOW_DEV_DB === "true" ? "postgresql://raged:raged@localhost:5432/raged" : undefined)
  );
}

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    const databaseUrl = getDatabaseUrl();

    if (!databaseUrl) {
      throw new Error(
        "DATABASE_URL is not set. Set DATABASE_URL (e.g., postgresql://raged:raged@localhost:5432/raged) or set ALLOW_DEV_DB=true for local development."
      );
    }

    pool = new Pool({
      connectionString: databaseUrl,
    });
  }
  return pool;
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<pg.QueryResult<T>> {
  const client = getPool();
  return client.query<T>(text, params);
}

export interface RunMigrationsOptions {
  log?: (message: string) => void;
}

export async function runMigrations(options?: RunMigrationsOptions): Promise<void> {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const migrationsDir = join(__dirname, "..", "migrations");

  // Create migrations tracking table if not exists
  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ DEFAULT now()
    );
  `);

  // Migration files to run
  const migrations = ["001_initial.sql", "002_add_payload_checksum.sql", "003_add_raw_data.sql"];

  for (const migrationFile of migrations) {
    const version = migrationFile.replace(".sql", "");

    const migrationPath = join(migrationsDir, migrationFile);
    const sql = await readFile(migrationPath, "utf-8");

    // Run migration in a transaction
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");

      const insertResult = await client.query<{ version: string }>(
        `
          INSERT INTO schema_migrations (version)
          VALUES ($1)
          ON CONFLICT (version) DO NOTHING
          RETURNING version
        `,
        [version]
      );

      if (insertResult.rowCount === 0) {
        await client.query("COMMIT");
        continue;
      }

      await client.query(sql);
      await client.query("COMMIT");
      options?.log?.(`Applied migration: ${migrationFile}`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
