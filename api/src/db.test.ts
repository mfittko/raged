import { describe, it, expect, afterAll } from "vitest";
import { getPool, query, runMigrations, closePool } from "./db.js";

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

describeDb("db module", () => {

  afterAll(async () => {
    await closePool();
  });

  it("getPool returns a pool instance", () => {
    const pool = getPool();
    expect(pool).toBeDefined();
  });

  it("query executes a simple SELECT", async () => {
    const result = await query("SELECT 1 as value");
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].value).toBe(1);
  });

  it("runMigrations creates schema_migrations table", async () => {
    await runMigrations();
    const result = await query("SELECT version FROM schema_migrations");
    expect(result.rows.length).toBeGreaterThanOrEqual(0);
  });

  it("runMigrations is idempotent", async () => {
    await runMigrations();
    const beforeCount = await query("SELECT COUNT(*) as count FROM schema_migrations");
    await runMigrations();
    const afterCount = await query("SELECT COUNT(*) as count FROM schema_migrations");
    // Should not create duplicate migration entries
    expect(afterCount.rows[0].count).toBe(beforeCount.rows[0].count);
  });
});
