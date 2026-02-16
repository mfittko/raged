import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { getPool, query, runMigrations, closePool } from "./db.js";

describe("db module", () => {
  const originalEnv = {
    DATABASE_URL: process.env.DATABASE_URL,
    ALLOW_DEV_DB: process.env.ALLOW_DEV_DB,
  };

  beforeAll(() => {
    if (!process.env.DATABASE_URL) {
      process.env.DATABASE_URL = "postgresql://localhost:5432/ragstack";
      delete process.env.ALLOW_DEV_DB;
    }
  });

  afterAll(async () => {
    await closePool();

    if (originalEnv.DATABASE_URL === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalEnv.DATABASE_URL;
    }

    if (originalEnv.ALLOW_DEV_DB === undefined) {
      delete process.env.ALLOW_DEV_DB;
    } else {
      process.env.ALLOW_DEV_DB = originalEnv.ALLOW_DEV_DB;
    }
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
