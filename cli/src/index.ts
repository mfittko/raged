#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { Command } from "commander";
import sharp from "sharp";

// Constants
const LARGE_IMAGE_THRESHOLD_BYTES = 1000000; // 1MB
const DEFAULT_MAX_FILES = 4000;

// Supported file extensions for ingest command
const SUPPORTED_INGEST_EXTS = new Set([
  ".txt", ".md", ".markdown", ".json", ".yaml", ".yml", ".csv",
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".java",
  ".cpp", ".c", ".html", ".htm", ".css", ".toml",
  ".pdf", ".png", ".jpg", ".jpeg", ".gif", ".webp"
]);

type IngestItem = { 
  id?: string; 
  text?: string; 
  url?: string;
  source?: string; 
  metadata?: Record<string, any>;
  docType?: string;
  enrich?: boolean;
};

function normalizePathForId(filePath: string): string {
  return filePath.replace(/[/\\]/g, ":");
}

function detectDocType(filePath: string): string {
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

async function readFileContent(filePath: string, docType: string): Promise<{ text: string; metadata?: Record<string, any> }> {
  if (docType === "pdf") {
    const buffer = await fs.readFile(filePath);
    try {
      // Dynamic import to handle module resolution
      const pdfModule: any = await import("pdf-parse");
      const parsePdf = pdfModule.default || pdfModule;
      const data = await parsePdf(buffer);
      return {
        text: data.text,
        metadata: {
          title: data.info?.Title,
          author: data.info?.Author,
          pageCount: data.numpages,
        },
      };
    } catch (error: any) {
      if (error?.code === "ERR_MODULE_NOT_FOUND" || error?.code === "MODULE_NOT_FOUND") {
        throw new Error(
          "pdf-parse package is required to process PDF files. Install it with: npm install pdf-parse"
        );
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to process PDF file "${filePath}": ${message}`);
    }
  }
  
  if (docType === "image") {
    const buffer = await fs.readFile(filePath);
    const fileSizeBytes = buffer.length;
    const base64 = buffer.toString("base64");
    const metadata: Record<string, any> = { 
      format: path.extname(filePath).slice(1),
      sizeBytes: fileSizeBytes 
    };
    
    try {
      const image = sharp(buffer);
      const meta = await image.metadata();
      metadata.width = meta.width;
      metadata.height = meta.height;
      if (meta.exif) {
        metadata.exif = meta.exif;
      }
    } catch (e) {
      console.warn(`[rag-index] Warning: Failed to extract image metadata for "${filePath}"`);
    }
    
    return { text: base64, metadata };
  }
  
  // For text and code files
  const text = await fs.readFile(filePath, "utf-8");
  return { text };
}

function run(cmd: string, args: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: "inherit", cwd });
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
    p.on("error", reject);
  });
}

async function listFiles(root: string, maxFiles?: number): Promise<string[]> {
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

function extToLang(file: string): string {
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

function isTextLike(file: string): boolean {
  const ext = path.extname(file).toLowerCase();
  const deny = new Set([
    ".png",".jpg",".jpeg",".gif",".webp",".pdf",".zip",".gz",".tar",".tgz",".7z",
    ".mp4",".mov",".mp3",".wav",".woff",".woff2",".ttf",".otf"
  ]);
  return !deny.has(ext);
}

function matchPrefix(rel: string, prefix?: string): boolean {
  if (!prefix) return true;
  const p = prefix.replace(/\\/g, "/");
  return rel.startsWith(p);
}

function authHeaders(token?: string): Record<string, string> {
  const t = token || process.env.RAG_API_TOKEN || "";
  if (!t) return {};
  return { authorization: `Bearer ${t}` };
}

async function ingest(api: string, collection: string, items: IngestItem[], token?: string) {
  const res = await fetch(`${api.replace(/\/$/, "")}/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders(token) },
    body: JSON.stringify({ collection, items }),
  });
  if (!res.ok) throw new Error(`Ingest failed: ${res.status} ${await res.text()}`);
  return await res.json();
}

function qdrantFilter(args: {repoId?: string, pathPrefix?: string, lang?: string}) {
  const must: any[] = [];
  if (args.repoId) must.push({ key: "repoId", match: { value: args.repoId } });
  if (args.pathPrefix) must.push({ key: "path", match: { text: args.pathPrefix } });
  if (args.lang) must.push({ key: "lang", match: { value: args.lang } });
  if (!must.length) return undefined;
  return { must };
}

async function query(api: string, collection: string, q: string, topK: number, filter?: any, token?: string) {
  const res = await fetch(`${api.replace(/\/$/, "")}/query`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders(token) },
    body: JSON.stringify({ collection, query: q, topK, filter }),
  });
  if (!res.ok) throw new Error(`Query failed: ${res.status} ${await res.text()}`);
  return await res.json();
}

async function cmdIndex(options: any) {
  const repoUrl = options.repo;
  const api = options.api || "http://localhost:8080";
  const token = options.token;
  const collection = options.collection || "docs";
  const branch = options.branch || "";
  const maxFiles = Number(options.maxFiles || 4000);
  const maxBytes = Number(options.maxBytes || 500_000);
  const keep = Boolean(options.keep);
  const repoId = String(options.repoId || repoUrl);
  const enrich = options.enrich !== false; // default true
  const docType = options.docType;

  const includePrefix = options.include;
  const excludePrefix = options.exclude;

  if (!repoUrl) {
    console.error("Error: --repo is required");
    process.exit(2);
  }

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rag-index-"));
  const repoDir = path.join(tmp, "repo");
  try {
    const cloneArgs = ["clone", "--depth", "1"];
    if (branch) cloneArgs.push("--branch", String(branch));
    cloneArgs.push(String(repoUrl), repoDir);

    console.log(`[rag-index] Cloning ${repoUrl} ...`);
    await run("git", cloneArgs);

    console.log(`[rag-index] Scanning files...`);
    const files = (await listFiles(repoDir)).slice(0, maxFiles);

    const items: IngestItem[] = [];
    for (const f of files) {
      if (!isTextLike(f)) continue;
      const rel = path.relative(repoDir, f).replace(/\\/g, "/");

      if (includePrefix && !matchPrefix(rel, includePrefix)) continue;
      if (excludePrefix && matchPrefix(rel, excludePrefix)) continue;

      const st = await fs.stat(f);
      if (st.size > maxBytes) continue;

      const text = await fs.readFile(f, "utf-8").catch(() => "");
      if (!text.trim()) continue;

      const item: IngestItem = {
        id: `${repoId}:${rel}`,
        text,
        source: `${repoUrl}#${rel}`,
        metadata: { repoId, repoUrl, path: rel, lang: extToLang(f), bytes: st.size },
      };
      
      if (docType) item.docType = docType;
      if (enrich !== undefined) item.enrich = enrich;
      
      items.push(item);

      if (items.length >= 50) {
        console.log(`[rag-index] Ingesting batch (${items.length})...`);
        await ingest(api, collection, items.splice(0, items.length), token);
      }
    }

    if (items.length) {
      console.log(`[rag-index] Ingesting final batch (${items.length})...`);
      await ingest(api, collection, items, token);
    }
    console.log(`[rag-index] Done. repoId=${repoId}`);
  } finally {
    if (keep) console.log(`[rag-index] Kept temp dir: ${tmp}`);
    else await fs.rm(tmp, { recursive: true, force: true });
  }
}

async function cmdQuery(options: any) {
  const api = options.api || "http://localhost:8080";
  const token = options.token;
  const collection = options.collection || "docs";
  const q = options.q || options.query;
  const topK = Number(options.topK || 8);
  const repoId = options.repoId;
  const pathPrefix = options.pathPrefix;
  const lang = options.lang;

  if (!q) {
    console.error("Error: --q or --query is required");
    process.exit(2);
  }

  const filter = qdrantFilter({ repoId, pathPrefix, lang });
  const out = await query(api, collection, String(q), topK, filter, token);

  const results = out?.results ?? [];
  if (!results.length) { console.log("No results."); return; }

  results.forEach((r: any, i: number) => {
    const snippet = String(r.text ?? "").replace(/\s+/g, " ").slice(0, 280);
    console.log(`#${i + 1}  score=${r.score}`);
    console.log(`source: ${r.source}`);
    console.log(snippet);
    console.log("");
  });
}

async function cmdIngest(options: any) {
  const api = options.api || "http://localhost:8080";
  const token = options.token;
  const collection = options.collection || "docs";
  const file = options.file;
  const dir = options.dir;
  const url = options.url;
  const enrich = options.enrich !== false;
  const docTypeOverride = options.docType;
  const maxFiles = Number(options.maxFiles || DEFAULT_MAX_FILES);

  // Check for mutual exclusion
  const inputCount = [file, dir, url].filter(Boolean).length;
  if (inputCount === 0) {
    console.error("Error: --file, --dir, or --url is required");
    process.exit(2);
  }
  if (inputCount > 1) {
    console.error("Error: --file, --dir, and --url are mutually exclusive");
    process.exit(2);
  }

  // Handle URL ingestion
  if (url) {
    console.log(`Fetching ${url} ...`);
    const item: IngestItem = { url };
    if (docTypeOverride) item.docType = docTypeOverride;
    if (enrich !== undefined) item.enrich = enrich;

    try {
      const result = await ingest(api, collection, [item], token);
      
      if (result.errors && result.errors.length > 0) {
        for (const err of result.errors) {
          console.error(`✗ Failed to ingest ${err.url} — ${err.reason}`);
        }
      }
      
      if (result.upserted > 0) {
        const docTypeLabel = docTypeOverride || "unknown";
        console.log(`✓ Ingested ${result.upserted} chunks from ${url} (${docTypeLabel})`);
      }
      
      if (result.upserted === 0 && (!result.errors || result.errors.length === 0)) {
        console.log(`✗ No content ingested from ${url}`);
      }
    } catch (err) {
      console.error(`✗ Failed to ingest ${url}:`, err);
      process.exit(1);
    }
    return;
  }

  const filesToProcess: string[] = [];
  
  if (file) {
    filesToProcess.push(file);
  } else if (dir) {
    // Pass maxFiles to listFiles for early-stop bounded traversal
    const allFiles = await listFiles(dir, maxFiles);
    filesToProcess.push(...allFiles);
    if (allFiles.length >= maxFiles) {
      console.warn(`[rag-index] Warning: Reached file limit of ${maxFiles}, some files may be skipped (use --maxFiles to adjust)`);
    }
  }

  const items: IngestItem[] = [];
  
  for (const filePath of filesToProcess) {
    try {
      const docType = docTypeOverride || detectDocType(filePath);
      
      // Skip unsupported file types when no override is provided
      if (!docTypeOverride && docType === "text") {
        const ext = path.extname(filePath).toLowerCase();
        
        if (ext && !SUPPORTED_INGEST_EXTS.has(ext)) {
          console.warn(`[rag-index] Skipping unsupported file type (${ext}): ${filePath}`);
          continue;
        }
      }
      
      const { text, metadata = {} } = await readFileContent(filePath, docType);
      
      // Warn about large images (check original file size from metadata)
      if (docType === "image" && metadata.sizeBytes > LARGE_IMAGE_THRESHOLD_BYTES) {
        console.warn(`[rag-index] Warning: Large image file (${Math.round(metadata.sizeBytes / 1024)}KB) will be base64-encoded: ${filePath}`);
      }
      
      const fileName = path.basename(filePath);
      const item: IngestItem = {
        id: `file:${normalizePathForId(filePath)}`,
        text,
        source: filePath,
        metadata: { ...metadata, fileName, filePath },
        docType,
        enrich,
      };
      
      items.push(item);
      
      if (items.length >= 10) {
        console.log(`[rag-index] Ingesting batch (${items.length})...`);
        await ingest(api, collection, items.splice(0, items.length), token);
      }
    } catch (err) {
      console.error(`[rag-index] Error processing ${filePath}:`, err);
    }
  }

  if (items.length) {
    console.log(`[rag-index] Ingesting final batch (${items.length})...`);
    await ingest(api, collection, items, token);
  }
  
  console.log(`[rag-index] Done. Processed ${filesToProcess.length} files.`);
}

async function cmdEnrich(options: any) {
  const api = options.api || "http://localhost:8080";
  const apiBase = api.replace(/\/$/, "");
  const token = options.token;
  const collection = options.collection || "docs";
  const force = Boolean(options.force);
  const statsOnly = Boolean(options.statsOnly);

  // Always show stats first (explicit behavior)
  const statsRes = await fetch(`${apiBase}/enrichment/stats`, {
    method: "GET",
    headers: authHeaders(token),
  });
  
  if (!statsRes.ok) {
    console.error(`Failed to get stats: ${statsRes.status} ${await statsRes.text()}`);
    process.exit(1);
  }
  
  const stats = await statsRes.json();
  console.log("\n=== Enrichment Statistics ===");
  console.log(`Queue:`);
  console.log(`  Pending: ${stats.queue.pending}`);
  console.log(`  Processing: ${stats.queue.processing}`);
  console.log(`  Dead Letter: ${stats.queue.deadLetter}`);
  console.log(`\nTotals:`);
  console.log(`  Enriched: ${stats.totals.enriched}`);
  console.log(`  Failed: ${stats.totals.failed}`);
  console.log(`  Pending: ${stats.totals.pending}`);
  console.log(`  Processing: ${stats.totals.processing}`);
  console.log(`  None: ${stats.totals.none}`);
  console.log("");

  if (statsOnly) {
    // Only show stats, don't enqueue
    return;
  }

  // Enqueue enrichment tasks
  const enqueueRes = await fetch(`${apiBase}/enrichment/enqueue`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders(token) },
    body: JSON.stringify({ collection, force }),
  });
  
  if (!enqueueRes.ok) {
    console.error(`Failed to enqueue: ${enqueueRes.status} ${await enqueueRes.text()}`);
    process.exit(1);
  }
  
  const result = await enqueueRes.json();
  if (force) {
    console.log(`[rag-index] Re-enqueued ${result.enqueued} tasks (including already-enriched items).`);
  } else {
    console.log(`[rag-index] Enqueued ${result.enqueued} pending tasks for enrichment.`);
  }
}

async function cmdGraph(options: any) {
  const api = options.api || "http://localhost:8080";
  const token = options.token;
  const entity = options.entity;

  if (!entity) {
    console.error("Error: --entity is required");
    process.exit(2);
  }

  const res = await fetch(`${api.replace(/\/$/, "")}/graph/entity/${encodeURIComponent(entity)}`, {
    method: "GET",
    headers: authHeaders(token),
  });

  if (!res.ok) {
    if (res.status === 404) {
      console.log(`Entity "${entity}" not found in the knowledge graph.`);
      return;
    }
    if (res.status === 503) {
      console.error("Graph functionality is not enabled (Neo4j not configured).");
      process.exit(1);
    }
    console.error(`Failed to get entity: ${res.status} ${await res.text()}`);
    process.exit(1);
  }

  const data = await res.json();
  
  console.log(`\n=== Entity: ${data.entity.name} ===`);
  console.log(`Type: ${data.entity.type}`);
  if (data.entity.description) {
    console.log(`Description: ${data.entity.description}`);
  }
  
  if (data.connections && data.connections.length > 0) {
    console.log(`\n=== Connections (${data.connections.length}) ===`);
    data.connections.forEach((conn: any) => {
      const arrow = conn.direction === "outgoing" ? "→" : "←";
      console.log(`  ${arrow} ${conn.entity} (${conn.relationship})`);
    });
  }
  
  if (data.documents && data.documents.length > 0) {
    console.log(`\n=== Related Documents (${data.documents.length}) ===`);
    data.documents.slice(0, 10).forEach((doc: any) => {
      console.log(`  - ${doc.id}`);
    });
    if (data.documents.length > 10) {
      console.log(`  ... and ${data.documents.length - 10} more`);
    }
  }
  console.log("");
}

async function main() {
  const program = new Command();
  
  program
    .name("rag-index")
    .description("CLI tool for indexing repositories and querying the RAG API")
    .version("1.0.0");

  program
    .command("index")
    .description("Clone a Git repository and index its files")
    .requiredOption("--repo <url>", "Git URL to clone")
    .option("--api <url>", "RAG API URL", "http://localhost:8080")
    .option("--collection <name>", "Qdrant collection name", "docs")
    .option("--branch <name>", "Git branch to clone")
    .option("--repoId <id>", "Stable identifier for this repo")
    .option("--token <token>", "Bearer token for auth")
    .option("--include <prefix>", "Only index files matching this path prefix")
    .option("--exclude <prefix>", "Skip files matching this path prefix")
    .option("--maxFiles <n>", "Maximum files to process", "4000")
    .option("--maxBytes <n>", "Maximum file size in bytes", "500000")
    .option("--keep", "Keep the cloned temp directory", false)
    .option("--no-enrich", "Disable enrichment")
    .option("--doc-type <type>", "Override document type detection")
    .action(cmdIndex);

  program
    .command("query")
    .description("Search the RAG API for relevant chunks")
    .requiredOption("--q <text>", "Search query text")
    .option("--api <url>", "RAG API URL", "http://localhost:8080")
    .option("--collection <name>", "Qdrant collection name", "docs")
    .option("--topK <n>", "Number of results to return", "8")
    .option("--repoId <id>", "Filter by repository ID")
    .option("--pathPrefix <prefix>", "Filter by file path prefix")
    .option("--lang <lang>", "Filter by language")
    .option("--token <token>", "Bearer token for auth")
    .action(cmdQuery);

  program
    .command("ingest")
    .description("Ingest arbitrary files (PDFs, images, text)")
    .option("--file <path>", "Single file to ingest")
    .option("--dir <path>", "Directory to ingest")
    .option("--url <url>", "URL to fetch and ingest")
    .option("--api <url>", "RAG API URL", "http://localhost:8080")
    .option("--collection <name>", "Qdrant collection name", "docs")
    .option("--token <token>", "Bearer token for auth")
    .option("--maxFiles <number>", "Maximum files to process from directory", String(DEFAULT_MAX_FILES))
    .option("--no-enrich", "Disable enrichment")
    .option("--doc-type <type>", "Override document type detection")
    .action(cmdIngest);

  program
    .command("enrich")
    .description("Trigger and monitor enrichment tasks")
    .option("--api <url>", "RAG API URL", "http://localhost:8080")
    .option("--collection <name>", "Qdrant collection name", "docs")
    .option("--token <token>", "Bearer token for auth")
    .option("--force", "Re-enqueue all items (including already-enriched)", false)
    .option("--stats-only", "Show enrichment stats without enqueueing", false)
    .action(cmdEnrich);

  program
    .command("graph")
    .description("Query the knowledge graph for entity information")
    .requiredOption("--entity <name>", "Entity name to look up")
    .option("--api <url>", "RAG API URL", "http://localhost:8080")
    .option("--token <token>", "Bearer token for auth")
    .action(cmdGraph);

  await program.parseAsync(process.argv);
}

main().catch((e) => { console.error(e); process.exit(1); });
