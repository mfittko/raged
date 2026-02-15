import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { logger } from "./logger.js";

describe("logger", () => {
  let consoleLogSpy: typeof console.log;
  let consoleWarnSpy: typeof console.warn;
  let consoleErrorSpy: typeof console.error;
  let consoleDirSpy: typeof console.dir;
  let logCalls: string[];
  let warnCalls: string[];
  let errorCalls: string[];
  let dirCalls: unknown[];

  beforeEach(() => {
    logCalls = [];
    warnCalls = [];
    errorCalls = [];
    dirCalls = [];

    consoleLogSpy = console.log;
    consoleWarnSpy = console.warn;
    consoleErrorSpy = console.error;
    consoleDirSpy = console.dir;

    console.log = (...args: unknown[]) => {
      logCalls.push(...args.map((arg) => 
        arg === null ? String(arg) :
        typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
      ));
    };
    console.warn = (...args: unknown[]) => {
      warnCalls.push(...args.map((arg) => 
        arg === null ? String(arg) :
        typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
      ));
    };
    console.error = (...args: unknown[]) => {
      errorCalls.push(...args.map((arg) => 
        arg === null ? String(arg) :
        typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
      ));
    };
    console.dir = (obj: unknown) => {
      dirCalls.push(obj);
    };

    // Reset logger options
    logger.setOptions({ quiet: false, json: false });
  });

  afterEach(() => {
    console.log = consoleLogSpy;
    console.warn = consoleWarnSpy;
    console.error = consoleErrorSpy;
    console.dir = consoleDirSpy;
  });

  describe("info", () => {
    it("should log info messages to stdout", () => {
      logger.info("Test message");
      expect(logCalls).toHaveLength(1);
      expect(logCalls[0]).toBe("Test message");
    });

    it("should log info messages with data", () => {
      logger.info("Test message", { key: "value" });
      expect(logCalls).toHaveLength(1);
      expect(logCalls[0]).toBe("Test message");
      expect(dirCalls).toHaveLength(1);
      expect(dirCalls[0]).toEqual({ key: "value" });
    });

    it("should not log when quiet mode is enabled", () => {
      logger.setOptions({ quiet: true });
      logger.info("Test message");
      expect(logCalls).toHaveLength(0);
    });

    it("should log JSON when json mode is enabled", () => {
      logger.setOptions({ json: true });
      logger.info("Test message");
      expect(logCalls).toHaveLength(1);
      const parsed = JSON.parse(logCalls[0]);
      expect(parsed.level).toBe("info");
      expect(parsed.message).toBe("Test message");
    });

    it("should log JSON with data when json mode is enabled", () => {
      logger.setOptions({ json: true });
      logger.info("Test message", { key: "value" });
      expect(logCalls).toHaveLength(1);
      const parsed = JSON.parse(logCalls[0]);
      expect(parsed.level).toBe("info");
      expect(parsed.message).toBe("Test message");
      expect(parsed.key).toBe("value");
    });
  });

  describe("warn", () => {
    it("should log warning messages to stderr", () => {
      logger.warn("Warning message");
      expect(warnCalls).toHaveLength(1);
      expect(warnCalls[0]).toBe("Warning message");
    });

    it("should log warning messages with data", () => {
      logger.warn("Warning message", { key: "value" });
      expect(warnCalls).toHaveLength(1);
      expect(warnCalls[0]).toBe("Warning message");
      expect(dirCalls).toHaveLength(1);
      expect(dirCalls[0]).toEqual({ key: "value" });
    });

    it("should not log when quiet mode is enabled", () => {
      logger.setOptions({ quiet: true });
      logger.warn("Warning message");
      expect(warnCalls).toHaveLength(0);
    });

    it("should log JSON when json mode is enabled", () => {
      logger.setOptions({ json: true });
      logger.warn("Warning message");
      expect(warnCalls).toHaveLength(1);
      const parsed = JSON.parse(warnCalls[0]);
      expect(parsed.level).toBe("warn");
      expect(parsed.message).toBe("Warning message");
    });

    it("should log JSON with data when json mode is enabled", () => {
      logger.setOptions({ json: true });
      logger.warn("Warning message", { reason: "test" });
      expect(warnCalls).toHaveLength(1);
      const parsed = JSON.parse(warnCalls[0]);
      expect(parsed.level).toBe("warn");
      expect(parsed.message).toBe("Warning message");
      expect(parsed.reason).toBe("test");
    });
  });

  describe("error", () => {
    it("should log error messages to stderr", () => {
      logger.error("Error message");
      expect(errorCalls).toHaveLength(1);
      expect(errorCalls[0]).toBe("Error message");
    });

    it("should log error messages with Error object", () => {
      const err = new Error("Test error");
      logger.error("Error message", err);
      expect(errorCalls).toHaveLength(2);
      expect(errorCalls[0]).toBe("Error message");
    });

    it("should log error messages with non-Error object", () => {
      logger.error("Error message", "string error");
      expect(errorCalls).toHaveLength(1);
      expect(errorCalls[0]).toBe("Error message");
      expect(dirCalls).toHaveLength(1);
      expect(dirCalls[0]).toBe("string error");
    });

    it("should use console.dir for non-Error objects", () => {
      const errorObj = { code: 500, details: "Internal error" };
      logger.error("Error message", errorObj);
      expect(errorCalls).toHaveLength(1);
      expect(errorCalls[0]).toBe("Error message");
      expect(dirCalls).toHaveLength(1);
      expect(dirCalls[0]).toEqual(errorObj);
    });

    it("should always log errors even in quiet mode", () => {
      logger.setOptions({ quiet: true });
      logger.error("Error message");
      expect(errorCalls).toHaveLength(1);
    });

    it("should log JSON when json mode is enabled", () => {
      logger.setOptions({ json: true });
      logger.error("Error message");
      expect(errorCalls).toHaveLength(1);
      const parsed = JSON.parse(errorCalls[0]);
      expect(parsed.level).toBe("error");
      expect(parsed.message).toBe("Error message");
    });

    it("should log JSON with Error object when json mode is enabled", () => {
      logger.setOptions({ json: true });
      const err = new Error("Test error");
      logger.error("Error message", err);
      expect(errorCalls).toHaveLength(1);
      const parsed = JSON.parse(errorCalls[0]);
      expect(parsed.level).toBe("error");
      expect(parsed.message).toBe("Error message");
      expect(parsed.error).toBe("Test error");
      expect(parsed.stack).toBeDefined();
    });

    it("should log JSON with non-Error when json mode is enabled", () => {
      logger.setOptions({ json: true });
      logger.error("Error message", { code: 500 });
      expect(errorCalls).toHaveLength(1);
      const parsed = JSON.parse(errorCalls[0]);
      expect(parsed.level).toBe("error");
      expect(parsed.message).toBe("Error message");
      expect(parsed.error).toEqual({ code: 500 });
    });
  });

  describe("setOptions", () => {
    it("should update quiet option", () => {
      logger.setOptions({ quiet: true });
      logger.info("Test");
      expect(logCalls).toHaveLength(0);

      logger.setOptions({ quiet: false });
      logger.info("Test");
      expect(logCalls).toHaveLength(1);
    });

    it("should update json option", () => {
      logger.setOptions({ json: true });
      logger.info("Test");
      expect(logCalls[0]).toContain('"level":"info"');

      logger.setOptions({ json: false });
      logger.info("Test");
      expect(logCalls[1]).toBe("Test");
    });

    it("should merge options", () => {
      logger.setOptions({ quiet: true });
      logger.setOptions({ json: true });
      // Both should be set
      logger.info("Test");
      expect(logCalls).toHaveLength(0); // quiet still active
    });
  });
});
