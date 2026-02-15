import { describe, it, expect } from "vitest";
import { cmdIndex } from "./index.js";

describe("index command", () => {
  it("should exit with error when repo is missing", async () => {
    const exitSpy = process.exit;
    let exitCode = 0;
    process.exit = ((code: number) => {
      exitCode = code;
      throw new Error("exit");
    }) as never;

    try {
      await cmdIndex({} as { repo: string });
    } catch (e) {
      // Expected to throw
    }

    expect(exitCode).toBe(2);
    process.exit = exitSpy;
  });

  it("should validate repo URL is provided", async () => {
    const exitSpy = process.exit;
    let exitCode = 0;
    process.exit = ((code: number) => {
      exitCode = code;
      throw new Error("exit");
    }) as never;

    try {
      await cmdIndex({ repo: "" });
    } catch (e) {
      // Expected to throw
    }

    expect(exitCode).toBe(2);
    process.exit = exitSpy;
  });

  it("should reject non-numeric maxFiles value", async () => {
    const exitSpy = process.exit;
    let exitCode = 0;
    process.exit = ((code: number) => {
      exitCode = code;
      throw new Error("exit");
    }) as never;

    try {
      await cmdIndex({ repo: "https://github.com/test/repo", maxFiles: "foo" });
    } catch (e) {
      // Expected to throw
    }

    expect(exitCode).toBe(2);
    process.exit = exitSpy;
  });

  it("should reject negative maxFiles value", async () => {
    const exitSpy = process.exit;
    let exitCode = 0;
    process.exit = ((code: number) => {
      exitCode = code;
      throw new Error("exit");
    }) as never;

    try {
      await cmdIndex({ repo: "https://github.com/test/repo", maxFiles: "-100" });
    } catch (e) {
      // Expected to throw
    }

    expect(exitCode).toBe(2);
    process.exit = exitSpy;
  });

  it("should reject non-numeric maxBytes value", async () => {
    const exitSpy = process.exit;
    let exitCode = 0;
    process.exit = ((code: number) => {
      exitCode = code;
      throw new Error("exit");
    }) as never;

    try {
      await cmdIndex({ repo: "https://github.com/test/repo", maxBytes: "bar" });
    } catch (e) {
      // Expected to throw
    }

    expect(exitCode).toBe(2);
    process.exit = exitSpy;
  });

  it("should reject zero maxBytes value", async () => {
    const exitSpy = process.exit;
    let exitCode = 0;
    process.exit = ((code: number) => {
      exitCode = code;
      throw new Error("exit");
    }) as never;

    try {
      await cmdIndex({ repo: "https://github.com/test/repo", maxBytes: "0" });
    } catch (e) {
      // Expected to throw
    }

    expect(exitCode).toBe(2);
    process.exit = exitSpy;
  });
});
