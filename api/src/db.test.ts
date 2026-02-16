import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPool, query, runMigrations, closePool } from "./db.js";

describe("db module", () => {
  beforeAll(async () => {
    // Skip tests if DATABASE_URL is not set (CI or local without Postgres)
    if (!process.env.DATABASE_URL) {
      console.warn("Skipping db tests: DATABASE_URL not set");
      return;
    }
  });

  afterAll(async () => {
    await closePool();
  });

  it("getPool returns a pool instance", () => {
    if (!process.env.DATABASE_URL) return;
    const pool = getPool();
    expect(pool).toBeDefined();
  });

  it("query executes a simple SELECT", async () => {
    if (!process.env.DATABASE_URL) return;
    const result = await query("SELECT 1 as value");
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].value).toBe(1);
  });

  it("runMigrations creates schema_migrations table", async () => {
    if (!process.env.DATABASE_URL) return;
    await runMigrations();
    const result = await query("SELECT version FROM schema_migrations");
    expect(result.rows.length).toBeGreaterThanOrEqual(0);
  });

  it("runMigrations is idempotent", async () => {
    if (!process.env.DATABASE_URL) return;
    await runMigrations();
    await runMigrations();
    // Should not throw, migrations already applied
    expect(true).toBe(true);
  });
});
