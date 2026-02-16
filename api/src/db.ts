import pg from "pg";
import { readFile } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL || "postgresql://rag:rag@localhost:5432/ragstack";

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: DATABASE_URL,
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

export async function runMigrations(): Promise<void> {
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

  // Get applied migrations
  const result = await query<{ version: string }>(
    "SELECT version FROM schema_migrations ORDER BY version"
  );
  const appliedMigrations = new Set(result.rows.map((r) => r.version));

  // Migration files to run
  const migrations = ["001_initial.sql"];

  for (const migrationFile of migrations) {
    const version = migrationFile.replace(".sql", "");
    
    if (appliedMigrations.has(version)) {
      continue;
    }

    const migrationPath = join(migrationsDir, migrationFile);
    const sql = await readFile(migrationPath, "utf-8");

    // Run migration in a transaction
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations (version) VALUES ($1)",
        [version]
      );
      await client.query("COMMIT");
      console.log(`Applied migration: ${migrationFile}`);
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
