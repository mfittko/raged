import { describe, it, expect } from "vitest";
import { extractCode } from "./code.js";
import type { IngestItem } from "../doctype.js";

describe("extractCode", () => {
  it("should extract language from file extension", () => {
    const item: IngestItem = {
      text: "function test() {}",
      source: "test.ts",
    };
    const result = extractCode(item);
    expect(result.lang).toBe("typescript");
  });

  it("should extract function names", () => {
    const item: IngestItem = {
      text: "function hello() {}\nfunction world() {}",
      source: "test.js",
    };
    const result = extractCode(item);
    expect(result.functions).toEqual(["hello", "world"]);
  });

  it("should extract class names", () => {
    const item: IngestItem = {
      text: "class MyClass {}\nclass AnotherClass {}",
      source: "test.ts",
    };
    const result = extractCode(item);
    expect(result.classes).toEqual(["MyClass", "AnotherClass"]);
  });

  it("should extract imports", () => {
    const item: IngestItem = {
      text: 'import { foo } from "bar";\nimport "baz";',
      source: "test.ts",
    };
    const result = extractCode(item);
    expect(result.imports).toContain("bar");
    expect(result.imports).toContain("baz");
  });

  it("should extract exports", () => {
    const item: IngestItem = {
      text: "export const foo = 1;\nexport function bar() {}",
      source: "test.ts",
    };
    const result = extractCode(item);
    expect(result.exports).toContain("foo");
    expect(result.exports).toContain("bar");
  });

  it("should limit function names to 100 items", () => {
    // Generate 150 function declarations
    const functions = Array.from({ length: 150 }, (_, i) => `function func${i}() {}`).join("\n");
    const item: IngestItem = {
      text: functions,
      source: "test.js",
    };
    const result = extractCode(item);
    expect(result.functions).toBeDefined();
    expect(result.functions!.length).toBeLessThanOrEqual(100);
  });

  it("should return empty object when no text provided", () => {
    const item: IngestItem = {
      source: "test.js",
    };
    const result = extractCode(item);
    expect(result.lang).toBe("javascript");
    expect(result.functions).toBeUndefined();
  });
});
