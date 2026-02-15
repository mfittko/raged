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
});
