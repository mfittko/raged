import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getDefaultApiUrl, loadDotEnvFromCwd } from "./env.js";

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

  it("keeps single-quoted escape sequences literal", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "raged-env-test-"));
    await fs.writeFile(path.join(dir, ".env"), "TEST_SINGLE='line1\\nline2'\n");

    delete process.env.TEST_SINGLE;

    await loadDotEnvFromCwd(dir);

    expect(process.env.TEST_SINGLE).toBe("line1\\nline2");

    delete process.env.TEST_SINGLE;
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe("getDefaultApiUrl", () => {
  it("uses RAGED_URL when set, even if API_HOST_PORT is present", () => {
    process.env.RAGED_URL = "https://example.com/api";
    process.env.API_HOST_PORT = "1234";

    expect(getDefaultApiUrl()).toBe("https://example.com/api");

    delete process.env.RAGED_URL;
    delete process.env.API_HOST_PORT;
  });

  it("uses API_HOST_PORT when it is numeric", () => {
    delete process.env.RAGED_URL;
    process.env.API_HOST_PORT = "3000";

    expect(getDefaultApiUrl()).toBe("http://localhost:3000");

    delete process.env.API_HOST_PORT;
  });

  it("falls back to default URL when neither value is usable", () => {
    delete process.env.RAGED_URL;
    process.env.API_HOST_PORT = "abc";

    expect(getDefaultApiUrl()).toBe("http://localhost:8080");

    delete process.env.API_HOST_PORT;
  });
});
