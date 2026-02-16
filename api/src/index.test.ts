import { describe, it, expect, afterEach } from "vitest";
import { validateConfig } from "./index.js";

describe("validateConfig", () => {
  const ORIGINAL_ENV = {
    DATABASE_URL: process.env.DATABASE_URL,
    OLLAMA_URL: process.env.OLLAMA_URL,
    QDRANT_URL: process.env.QDRANT_URL,
    ALLOW_DEV_DB: process.env.ALLOW_DEV_DB,
    LEGACY_QDRANT_VECTOR_ENABLED: process.env.LEGACY_QDRANT_VECTOR_ENABLED,
  };

  afterEach(() => {
    // Restore original env vars
    Object.entries(ORIGINAL_ENV).forEach(([key, value]) => {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    });
  });

  it("returns errors when DATABASE_URL is missing and ALLOW_DEV_DB is not set", () => {
    delete process.env.DATABASE_URL;
    delete process.env.ALLOW_DEV_DB;
    process.env.OLLAMA_URL = "http://localhost:11434";
    delete process.env.LEGACY_QDRANT_VECTOR_ENABLED;

    const errors = validateConfig();
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some(e => e.includes("DATABASE_URL"))).toBe(true);
  });

  it("does not return DATABASE_URL error when ALLOW_DEV_DB=true", () => {
    delete process.env.DATABASE_URL;
    process.env.ALLOW_DEV_DB = "true";
    process.env.OLLAMA_URL = "http://localhost:11434";
    delete process.env.LEGACY_QDRANT_VECTOR_ENABLED;

    const errors = validateConfig();
    expect(errors.some(e => e.includes("DATABASE_URL"))).toBe(false);
  });

  it("returns error when OLLAMA_URL is missing", () => {
    process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
    delete process.env.OLLAMA_URL;
    delete process.env.LEGACY_QDRANT_VECTOR_ENABLED;

    const errors = validateConfig();
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some(e => e.includes("OLLAMA_URL"))).toBe(true);
  });

  it("returns error when QDRANT_URL is missing and legacy path is enabled", () => {
    process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
    process.env.OLLAMA_URL = "http://localhost:11434";
    delete process.env.QDRANT_URL;
    process.env.LEGACY_QDRANT_VECTOR_ENABLED = "true";

    const errors = validateConfig();
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some(e => e.includes("QDRANT_URL"))).toBe(true);
  });

  it("does not return QDRANT_URL error when legacy path is disabled", () => {
    process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
    process.env.OLLAMA_URL = "http://localhost:11434";
    delete process.env.QDRANT_URL;
    delete process.env.LEGACY_QDRANT_VECTOR_ENABLED;

    const errors = validateConfig();
    expect(errors.some(e => e.includes("QDRANT_URL"))).toBe(false);
  });

  it("returns empty array when all required config is present", () => {
    process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
    process.env.OLLAMA_URL = "http://localhost:11434";
    delete process.env.LEGACY_QDRANT_VECTOR_ENABLED;

    const errors = validateConfig();
    expect(errors.length).toBe(0);
  });

  it("returns multiple errors when multiple configs are missing", () => {
    delete process.env.DATABASE_URL;
    delete process.env.ALLOW_DEV_DB;
    delete process.env.OLLAMA_URL;
    delete process.env.LEGACY_QDRANT_VECTOR_ENABLED;

    const errors = validateConfig();
    expect(errors.length).toBe(2);
    expect(errors.some(e => e.includes("DATABASE_URL"))).toBe(true);
    expect(errors.some(e => e.includes("OLLAMA_URL"))).toBe(true);
    expect(errors.some(e => e.includes("QDRANT_URL"))).toBe(false);
  });
});
