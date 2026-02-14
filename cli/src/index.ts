#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import minimist from "minimist";

type IngestItem = { id?: string; text: string; source: string; metadata?: Record<string, any>; };

function usage() {
  console.log(`rag-index

Usage:
  rag-index index --repo <git-url> [--api <url>] [--collection <name>] [--branch <name>] [--repoId <id>] [--token <token>]
  rag-index query --q "<text>" [--api <url>] [--collection <name>] [--topK <n>] [--repoId <id>] [--pathPrefix <prefix>] [--lang <lang>] [--token <token>]

Defaults:
  --api http://localhost:8080
  --collection docs
`);
}

function run(cmd: string, args: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: "inherit", cwd });
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
    p.on("error", reject);
  });
}

async function listFiles(root: string): Promise<string[]> {
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
      else if (e.isFile()) out.push(full);
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

async function cmdIndex(argv: any) {
  const repoUrl = argv.repo || argv.r;
  const api = argv.api || "http://localhost:8080";
  const token = argv.token ? String(argv.token) : undefined;
  const collection = argv.collection || "docs";
  const branch = argv.branch || "";
  const maxFiles = Number(argv.maxFiles || 4000);
  const maxBytes = Number(argv.maxBytes || 500_000);
  const keep = Boolean(argv.keep);
  const repoId = String(argv.repoId || repoUrl);

  const includePrefix = argv.include ? String(argv.include) : undefined;
  const excludePrefix = argv.exclude ? String(argv.exclude) : undefined;

  if (!repoUrl) { usage(); process.exit(2); }

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

      items.push({
        id: `${repoId}:${rel}`,
        text,
        source: `${repoUrl}#${rel}`,
        metadata: { repoId, repoUrl, path: rel, lang: extToLang(f), bytes: st.size },
      });

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

async function cmdQuery(argv: any) {
  const api = argv.api || "http://localhost:8080";
  const token = argv.token ? String(argv.token) : undefined;
  const collection = argv.collection || "docs";
  const q = argv.q || argv.query;
  const topK = Number(argv.topK || 8);
  const repoId = argv.repoId ? String(argv.repoId) : undefined;
  const pathPrefix = argv.pathPrefix ? String(argv.pathPrefix) : undefined;
  const lang = argv.lang ? String(argv.lang) : undefined;

  if (!q) { usage(); process.exit(2); }

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

async function main() {
  const argv = minimist(process.argv.slice(2));
  const cmd = argv._[0];

  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") { usage(); return; }
  if (cmd === "index") return await cmdIndex(argv);
  if (cmd === "query") return await cmdQuery(argv);

  usage();
  process.exit(2);
}

main().catch((e) => { console.error(e); process.exit(1); });
