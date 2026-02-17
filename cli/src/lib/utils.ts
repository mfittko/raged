import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import sharp from "sharp";
import type { IngestItem } from "./types.js";

export const LARGE_IMAGE_THRESHOLD_BYTES = 1000000; // 1MB
export const DEFAULT_MAX_FILES = 4000;

export const SUPPORTED_INGEST_EXTS = new Set([
  ".txt", ".md", ".markdown", ".json", ".yaml", ".yml", ".csv",
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".java",
  ".cpp", ".c", ".html", ".htm", ".css", ".toml",
  ".pdf", ".png", ".jpg", ".jpeg", ".gif", ".webp"
]);

export function normalizePathForId(filePath: string): string {
  return filePath.replace(/[/\\]/g, ":");
}

export function detectDocType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const extMap: Record<string, string> = {
    ".md": "text", ".markdown": "text", ".txt": "text",
    ".ts": "code", ".tsx": "code", ".js": "code", ".jsx": "code",
    ".py": "code", ".go": "code", ".java": "code", ".cpp": "code", ".c": "code",
    ".json": "code", ".yml": "code", ".yaml": "code", ".toml": "code",
    ".pdf": "pdf",
    ".png": "image", ".jpg": "image", ".jpeg": "image", ".gif": "image", ".webp": "image",
  };
  
  // Check for Slack export structure (case-insensitive)
  if (filePath.toLowerCase().includes("slack") && ext === ".json") {
    return "slack";
  }
  
  return extMap[ext] ?? "text";
}

export async function readFileContent(
  filePath: string,
  docType: string
): Promise<{ text: string; metadata?: Record<string, unknown>; rawData?: string; rawMimeType?: string }> {
  if (docType === "pdf") {
    const buffer = await fs.readFile(filePath);
    try {
      const pdfModule = await import("pdf-parse") as unknown as {
        PDFParse?: new (opts: { data: Buffer }) => {
          getText: () => Promise<{ text: string; total?: number }>;
          getInfo: () => Promise<{ total?: number; info?: { Title?: string; Author?: string } }>;
          destroy: () => Promise<void>;
        };
        default?: (buffer: Buffer) => Promise<{
          text: string;
          numpages?: number;
          info?: {
            Title?: string;
            Author?: string;
          };
        }>;
      };

      if (typeof pdfModule.PDFParse === "function") {
        const parser = new pdfModule.PDFParse({ data: buffer });
        try {
          const textResult = await parser.getText();
          const infoResult = await parser.getInfo();
          return {
            text: textResult.text,
            metadata: {
              title: infoResult.info?.Title,
              author: infoResult.info?.Author,
              pageCount: infoResult.total ?? textResult.total,
              sizeBytes: buffer.length,
              contentType: "application/pdf",
            },
            rawData: buffer.toString("base64"),
            rawMimeType: "application/pdf",
          };
        } finally {
          await parser.destroy();
        }
      }

      if (typeof pdfModule.default === "function") {
        const data = await pdfModule.default(buffer);
        return {
          text: data.text,
          metadata: {
            title: data.info?.Title,
            author: data.info?.Author,
            pageCount: data.numpages,
            sizeBytes: buffer.length,
            contentType: "application/pdf",
          },
          rawData: buffer.toString("base64"),
          rawMimeType: "application/pdf",
        };
      }

      throw new Error("Unsupported pdf-parse module shape");
    } catch (error: unknown) {
      if (error && typeof error === "object" && "code" in error) {
        const code = (error as { code: string }).code;
        if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") {
          throw new Error(
            "pdf-parse package is required to process PDF files. Install it with: npm install pdf-parse"
          );
        }
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to process PDF file "${filePath}": ${message}`);
    }
  }
  
  if (docType === "image") {
    const buffer = await fs.readFile(filePath);
    const fileSizeBytes = buffer.length;
    const base64 = buffer.toString("base64");
    const extension = path.extname(filePath).slice(1).toLowerCase();
    const mimeByExt: Record<string, string> = {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      webp: "image/webp",
    };
    const contentType = mimeByExt[extension] || "application/octet-stream";
    const metadata: Record<string, unknown> = { 
      format: extension,
      sizeBytes: fileSizeBytes,
      contentType,
    };
    
    try {
      const image = sharp(buffer);
      const meta = await image.metadata();
      metadata.width = meta.width;
      metadata.height = meta.height;
      if (meta.exif) {
        metadata.exif = meta.exif;
      }
    } catch (error: unknown) {
      // Log debug message for metadata extraction failures
      const message = error instanceof Error ? error.message : String(error);
      if (typeof console !== "undefined" && typeof console.debug === "function") {
        console.debug(`Failed to extract image metadata for "${filePath}": ${message}`);
      }
    }
    
    return { text: base64, metadata, rawData: base64, rawMimeType: contentType };
  }
  
  // For text and code files
  const text = await fs.readFile(filePath, "utf-8");
  return { text };
}

export function run(cmd: string, args: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: "inherit", cwd });
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
    p.on("error", reject);
  });
}

export async function listFiles(root: string, maxFiles?: number): Promise<string[]> {
  const out: string[] = [];
  const stack = [root];
  const ignore = new Set([".git", "node_modules", "dist", "build", "target", ".next", ".cache", "vendor"]);
  while (stack.length) {
    const dir = stack.pop()!;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (ignore.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile()) {
        out.push(full);
        // Early stop if we've reached the limit
        if (maxFiles !== undefined && out.length >= maxFiles) {
          return out;
        }
      }
    }
  }
  return out;
}

export function extToLang(file: string): string {
  const ext = path.extname(file).toLowerCase();
  const map: Record<string, string> = {
    ".md": "md", ".markdown": "md",
    ".ts": "ts", ".tsx": "tsx",
    ".js": "js", ".jsx": "jsx",
    ".go": "go", ".py": "py",
    ".json": "json", ".yml": "yaml", ".yaml": "yaml",
    ".toml": "toml", ".txt": "text",
  };
  return map[ext] ?? "text";
}

export function isTextLike(file: string): boolean {
  const ext = path.extname(file).toLowerCase();
  const deny = new Set([
    ".png",".jpg",".jpeg",".gif",".webp",".pdf",".zip",".gz",".tar",".tgz",".7z",
    ".mp4",".mov",".mp3",".wav",".woff",".woff2",".ttf",".otf"
  ]);
  return !deny.has(ext);
}

export function matchPrefix(rel: string, prefix?: string): boolean {
  if (!prefix) return true;
  const p = prefix.replace(/\\/g, "/");
  return rel.startsWith(p);
}
