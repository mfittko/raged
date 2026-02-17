import { describe, it, expect, afterEach } from "vitest";
import { validateConfig } from "./index.js";

describe("validateConfig", () => {
  const ORIGINAL_ENV = {
    DATABASE_URL: process.env.DATABASE_URL,
    OLLAMA_URL: process.env.OLLAMA_URL,
    ALLOW_DEV_DB: process.env.ALLOW_DEV_DB,
    EMBED_PROVIDER: process.env.EMBED_PROVIDER,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
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

    const errors = validateConfig();
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some(e => e.includes("DATABASE_URL"))).toBe(true);
  });

  it("does not return DATABASE_URL error when ALLOW_DEV_DB=true", () => {
    delete process.env.DATABASE_URL;
    process.env.ALLOW_DEV_DB = "true";
    process.env.OLLAMA_URL = "http://localhost:11434";

    const errors = validateConfig();
    expect(errors.some(e => e.includes("DATABASE_URL"))).toBe(false);
  });

  it("returns error when OLLAMA_URL is missing", () => {
    process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
    delete process.env.EMBED_PROVIDER;
    delete process.env.OLLAMA_URL;

    const errors = validateConfig();
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some(e => e.includes("OLLAMA_URL"))).toBe(true);
  });

  it("does not require OLLAMA_URL when EMBED_PROVIDER=openai and OPENAI_API_KEY is set", () => {
    process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
    process.env.EMBED_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "test-openai-key";
    delete process.env.OLLAMA_URL;

    const errors = validateConfig();
    expect(errors.some(e => e.includes("OLLAMA_URL"))).toBe(false);
    expect(errors.some(e => e.includes("OPENAI_API_KEY"))).toBe(false);
  });

  it("returns error when OPENAI_API_KEY is missing for EMBED_PROVIDER=openai", () => {
    process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
    process.env.EMBED_PROVIDER = "openai";
    delete process.env.OPENAI_API_KEY;

    const errors = validateConfig();
    expect(errors.some(e => e.includes("OPENAI_API_KEY"))).toBe(true);
  });

  it("returns error when EMBED_PROVIDER is invalid", () => {
    process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
    process.env.EMBED_PROVIDER = "invalid-provider";
    process.env.OLLAMA_URL = "http://localhost:11434";

    const errors = validateConfig();
    expect(errors.some(e => e.includes("EMBED_PROVIDER"))).toBe(true);
  });

  it("returns empty array when all required config is present", () => {
    process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
    delete process.env.EMBED_PROVIDER;
    process.env.OLLAMA_URL = "http://localhost:11434";

    const errors = validateConfig();
    expect(errors.length).toBe(0);
  });

  it("returns multiple errors when multiple configs are missing", () => {
    delete process.env.DATABASE_URL;
    delete process.env.ALLOW_DEV_DB;
    process.env.EMBED_MODEL = "mxbai-embed-large";
    delete process.env.OLLAMA_URL;

    const errors = validateConfig();
    expect(errors.length).toBe(2);
    expect(errors.some(e => e.includes("DATABASE_URL"))).toBe(true);
    expect(errors.some(e => e.includes("OLLAMA_URL"))).toBe(true);
  });

  it("returns error when default Ollama model is incompatible with vector(1536)", () => {
    process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
    delete process.env.EMBED_PROVIDER;
    delete process.env.EMBED_MODEL;
    process.env.OLLAMA_URL = "http://localhost:11434";

    const errors = validateConfig();
    expect(errors.some(e => e.includes("nomic-embed-text"))).toBe(true);
    expect(errors.some(e => e.includes("vector(1536)"))).toBe(true);
  });

  it("returns error when OPENAI_EMBEDDING_MODEL=text-embedding-3-large", () => {
    process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
    process.env.EMBED_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "test-openai-key";
    process.env.OPENAI_EMBEDDING_MODEL = "text-embedding-3-large";

    const errors = validateConfig();
    expect(errors.some(e => e.includes("text-embedding-3-large"))).toBe(true);
    expect(errors.some(e => e.includes("vector(1536)"))).toBe(true);
  });
});
