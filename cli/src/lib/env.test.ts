import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadDotEnvFromCwd } from "./env.js";

describe("loadDotEnvFromCwd", () => {
  it("loads .env values when present", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "raged-env-test-"));
    await fs.writeFile(path.join(dir, ".env"), "RAGED_API_TOKEN=from-dotenv\nAPI_HOST_PORT=39180\n");

    delete process.env.RAGED_API_TOKEN;
    delete process.env.API_HOST_PORT;

    await loadDotEnvFromCwd(dir);

    expect(process.env.RAGED_API_TOKEN).toBe("from-dotenv");
    expect(process.env.API_HOST_PORT).toBe("39180");

    await fs.rm(dir, { recursive: true, force: true });
  });

  it("does not override already-set environment variables", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "raged-env-test-"));
    await fs.writeFile(path.join(dir, ".env"), "RAGED_API_TOKEN=from-dotenv\n");

    process.env.RAGED_API_TOKEN = "already-set";

    await loadDotEnvFromCwd(dir);

    expect(process.env.RAGED_API_TOKEN).toBe("already-set");

    delete process.env.RAGED_API_TOKEN;
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("parses quoted values, export prefix, and inline comments", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "raged-env-test-"));
    await fs.writeFile(
      path.join(dir, ".env"),
      [
        'OPENAI_BASE_URL="http://localhost:11434/v1"',
        "export EXTRACTOR_PROVIDER=openai",
        "WORKER_CONCURRENCY=4 # inline comment",
      ].join("\n")
    );

    delete process.env.OPENAI_BASE_URL;
    delete process.env.EXTRACTOR_PROVIDER;
    delete process.env.WORKER_CONCURRENCY;

    await loadDotEnvFromCwd(dir);

    expect(process.env.OPENAI_BASE_URL).toBe("http://localhost:11434/v1");
    expect(process.env.EXTRACTOR_PROVIDER).toBe("openai");
    expect(process.env.WORKER_CONCURRENCY).toBe("4");

    await fs.rm(dir, { recursive: true, force: true });
  });
});
