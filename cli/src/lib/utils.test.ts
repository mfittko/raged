import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import {
  normalizePathForId,
  detectDocType,
  extToLang,
  isTextLike,
  matchPrefix,
  qdrantFilter,
  readFileContent,
  listFiles,
  SUPPORTED_INGEST_EXTS,
  LARGE_IMAGE_THRESHOLD_BYTES,
  DEFAULT_MAX_FILES,
} from "./utils.js";

describe("utils", () => {
  describe("constants", () => {
    it("should have correct LARGE_IMAGE_THRESHOLD_BYTES", () => {
      expect(LARGE_IMAGE_THRESHOLD_BYTES).toBe(1000000);
    });

    it("should have correct DEFAULT_MAX_FILES", () => {
      expect(DEFAULT_MAX_FILES).toBe(4000);
    });

    it("should have supported extensions", () => {
      expect(SUPPORTED_INGEST_EXTS.has(".txt")).toBe(true);
      expect(SUPPORTED_INGEST_EXTS.has(".md")).toBe(true);
      expect(SUPPORTED_INGEST_EXTS.has(".pdf")).toBe(true);
      expect(SUPPORTED_INGEST_EXTS.has(".png")).toBe(true);
      expect(SUPPORTED_INGEST_EXTS.has(".unknown")).toBe(false);
    });
  });

  describe("normalizePathForId", () => {
    it("should replace forward slashes with colons", () => {
      expect(normalizePathForId("path/to/file.txt")).toBe("path:to:file.txt");
    });

    it("should replace backslashes with colons", () => {
      expect(normalizePathForId("path\\to\\file.txt")).toBe("path:to:file.txt");
    });

    it("should handle mixed slashes", () => {
      expect(normalizePathForId("path/to\\file.txt")).toBe("path:to:file.txt");
    });

    it("should handle paths with no slashes", () => {
      expect(normalizePathForId("file.txt")).toBe("file.txt");
    });
  });

  describe("detectDocType", () => {
    it("should detect markdown as text", () => {
      expect(detectDocType("file.md")).toBe("text");
      expect(detectDocType("file.markdown")).toBe("text");
    });

    it("should detect txt as text", () => {
      expect(detectDocType("file.txt")).toBe("text");
    });

    it("should detect code files as code", () => {
      expect(detectDocType("file.ts")).toBe("code");
      expect(detectDocType("file.js")).toBe("code");
      expect(detectDocType("file.py")).toBe("code");
      expect(detectDocType("file.go")).toBe("code");
      expect(detectDocType("file.json")).toBe("code");
    });

    it("should detect PDF files", () => {
      expect(detectDocType("file.pdf")).toBe("pdf");
    });

    it("should detect image files", () => {
      expect(detectDocType("file.png")).toBe("image");
      expect(detectDocType("file.jpg")).toBe("image");
      expect(detectDocType("file.jpeg")).toBe("image");
    });

    it("should detect Slack JSON files", () => {
      expect(detectDocType("slack/export/data.json")).toBe("slack");
      expect(detectDocType("Slack/Export/data.json")).toBe("slack");
      expect(detectDocType("SLACK_export.json")).toBe("slack");
    });

    it("should default to text for unknown extensions", () => {
      expect(detectDocType("file.unknown")).toBe("text");
    });

    it("should be case insensitive for extensions", () => {
      expect(detectDocType("file.MD")).toBe("text");
      expect(detectDocType("file.PDF")).toBe("pdf");
      expect(detectDocType("file.PNG")).toBe("image");
    });
  });

  describe("extToLang", () => {
    it("should map markdown extensions to md", () => {
      expect(extToLang("file.md")).toBe("md");
      expect(extToLang("file.markdown")).toBe("md");
    });

    it("should map TypeScript extensions correctly", () => {
      expect(extToLang("file.ts")).toBe("ts");
      expect(extToLang("file.tsx")).toBe("tsx");
    });

    it("should map JavaScript extensions correctly", () => {
      expect(extToLang("file.js")).toBe("js");
      expect(extToLang("file.jsx")).toBe("jsx");
    });

    it("should map other languages", () => {
      expect(extToLang("file.py")).toBe("py");
      expect(extToLang("file.go")).toBe("go");
      expect(extToLang("file.json")).toBe("json");
      expect(extToLang("file.yaml")).toBe("yaml");
      expect(extToLang("file.yml")).toBe("yaml");
    });

    it("should default to text for unknown extensions", () => {
      expect(extToLang("file.unknown")).toBe("text");
    });

    it("should be case insensitive", () => {
      expect(extToLang("file.MD")).toBe("md");
      expect(extToLang("file.TS")).toBe("ts");
    });
  });

  describe("isTextLike", () => {
    it("should return true for text files", () => {
      expect(isTextLike("file.txt")).toBe(true);
      expect(isTextLike("file.md")).toBe(true);
      expect(isTextLike("file.js")).toBe(true);
    });

    it("should return false for binary image files", () => {
      expect(isTextLike("file.png")).toBe(false);
      expect(isTextLike("file.jpg")).toBe(false);
      expect(isTextLike("file.jpeg")).toBe(false);
      expect(isTextLike("file.gif")).toBe(false);
      expect(isTextLike("file.webp")).toBe(false);
    });

    it("should return false for PDF files", () => {
      expect(isTextLike("file.pdf")).toBe(false);
    });

    it("should return false for compressed files", () => {
      expect(isTextLike("file.zip")).toBe(false);
      expect(isTextLike("file.gz")).toBe(false);
      expect(isTextLike("file.tar")).toBe(false);
    });

    it("should return false for media files", () => {
      expect(isTextLike("file.mp4")).toBe(false);
      expect(isTextLike("file.mp3")).toBe(false);
    });

    it("should return false for font files", () => {
      expect(isTextLike("file.woff")).toBe(false);
      expect(isTextLike("file.ttf")).toBe(false);
    });

    it("should return true for unknown extensions", () => {
      expect(isTextLike("file.unknown")).toBe(true);
    });
  });

  describe("matchPrefix", () => {
    it("should return true when no prefix is provided", () => {
      expect(matchPrefix("any/path", undefined)).toBe(true);
      expect(matchPrefix("any/path")).toBe(true);
    });

    it("should match paths with the given prefix", () => {
      expect(matchPrefix("src/utils/file.ts", "src/utils")).toBe(true);
      expect(matchPrefix("src/file.ts", "src/")).toBe(true);
    });

    it("should not match paths without the prefix", () => {
      expect(matchPrefix("lib/file.ts", "src/")).toBe(false);
      expect(matchPrefix("test/file.ts", "src/")).toBe(false);
    });

    it("should handle backslashes in prefix", () => {
      expect(matchPrefix("src/utils/file.ts", "src\\utils")).toBe(true);
    });

    it("should handle exact prefix matches", () => {
      expect(matchPrefix("src", "src")).toBe(true);
    });

    it("should be case sensitive", () => {
      expect(matchPrefix("SRC/file.ts", "src/")).toBe(false);
    });
  });

  describe("readFileContent", () => {
    it("should read text files", async () => {
      const tmpFile = "/tmp/test-text-file.txt";
      await fs.writeFile(tmpFile, "Test content");
      
      const result = await readFileContent(tmpFile, "text");
      expect(result.text).toBe("Test content");
      expect(result.metadata).toBeUndefined();
      
      await fs.unlink(tmpFile);
    });

    it("should read code files", async () => {
      const tmpFile = "/tmp/test-code-file.js";
      await fs.writeFile(tmpFile, "const x = 1;");
      
      const result = await readFileContent(tmpFile, "code");
      expect(result.text).toBe("const x = 1;");
      
      await fs.unlink(tmpFile);
    });
  });

  describe("listFiles", () => {
    it("should list files in directory", async () => {
      const tmpDir = "/tmp/test-list-files";
      await fs.mkdir(tmpDir, { recursive: true });
      await fs.writeFile(`${tmpDir}/file1.txt`, "content1");
      await fs.writeFile(`${tmpDir}/file2.txt`, "content2");
      
      const result = await listFiles(tmpDir);
      expect(result.length).toBe(2);
      expect(result.some(f => f.includes("file1.txt"))).toBe(true);
      expect(result.some(f => f.includes("file2.txt"))).toBe(true);
      
      await fs.rm(tmpDir, { recursive: true });
    });

    it("should respect maxFiles limit", async () => {
      const tmpDir = "/tmp/test-list-files-max";
      await fs.mkdir(tmpDir, { recursive: true });
      await fs.writeFile(`${tmpDir}/file1.txt`, "content1");
      await fs.writeFile(`${tmpDir}/file2.txt`, "content2");
      await fs.writeFile(`${tmpDir}/file3.txt`, "content3");
      
      const result = await listFiles(tmpDir, 2);
      expect(result.length).toBe(2);
      
      await fs.rm(tmpDir, { recursive: true });
    });

    it("should ignore common directories", async () => {
      const tmpDir = "/tmp/test-list-files-ignore";
      await fs.mkdir(tmpDir, { recursive: true });
      await fs.mkdir(`${tmpDir}/node_modules`, { recursive: true });
      await fs.mkdir(`${tmpDir}/.git`, { recursive: true });
      await fs.writeFile(`${tmpDir}/file1.txt`, "content1");
      await fs.writeFile(`${tmpDir}/node_modules/file2.txt`, "content2");
      
      const result = await listFiles(tmpDir);
      expect(result.length).toBe(1);
      expect(result[0]).toContain("file1.txt");
      
      await fs.rm(tmpDir, { recursive: true });
    });

    it("should traverse subdirectories", async () => {
      const tmpDir = "/tmp/test-list-files-subdir";
      await fs.mkdir(`${tmpDir}/subdir`, { recursive: true });
      await fs.writeFile(`${tmpDir}/file1.txt`, "content1");
      await fs.writeFile(`${tmpDir}/subdir/file2.txt`, "content2");
      
      const result = await listFiles(tmpDir);
      expect(result.length).toBe(2);
      
      await fs.rm(tmpDir, { recursive: true });
    });
  });

  describe("qdrantFilter", () => {
    it("should return undefined when no filters are provided", () => {
      expect(qdrantFilter({})).toBeUndefined();
    });

    it("should create filter for repoId only", () => {
      const filter = qdrantFilter({ repoId: "my-repo" });
      expect(filter).toEqual({
        must: [{ key: "repoId", match: { value: "my-repo" } }],
      });
    });

    it("should create filter for pathPrefix only", () => {
      const filter = qdrantFilter({ pathPrefix: "src/" });
      expect(filter).toEqual({
        must: [{ key: "path", match: { text: "src/" } }],
      });
    });

    it("should create filter for lang only", () => {
      const filter = qdrantFilter({ lang: "typescript" });
      expect(filter).toEqual({
        must: [{ key: "lang", match: { value: "typescript" } }],
      });
    });

    it("should create filter with multiple conditions", () => {
      const filter = qdrantFilter({
        repoId: "my-repo",
        pathPrefix: "src/",
        lang: "typescript",
      });
      expect(filter).toEqual({
        must: [
          { key: "repoId", match: { value: "my-repo" } },
          { key: "path", match: { text: "src/" } },
          { key: "lang", match: { value: "typescript" } },
        ],
      });
    });

    it("should create filter with any combination of parameters", () => {
      const filter1 = qdrantFilter({ repoId: "repo1", lang: "js" });
      expect(filter1?.must).toHaveLength(2);

      const filter2 = qdrantFilter({ pathPrefix: "lib/", lang: "ts" });
      expect(filter2?.must).toHaveLength(2);
    });
  });
});
