import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

/**
 * Extract Google Chrome bookmarks as a URL list.
 * Output can be fed directly to: raged ingest --urls-file <file> --url-check
 *
 * Usage: node extract-chrome-bookmarks.mjs [OPTIONS]
 *
 * Options:
 *   -o, --output <file>   Write URLs to file (default: stdout)
 *   -f, --folder <name>   Only export bookmarks from folder (case-insensitive substring)
 *   --with-names           Output "URL\tName" format instead of URL-only
 *   --profile <name>       Chrome profile directory name (default: Default)
 *   --ingest               Run `raged ingest --urls-file` after extraction
 *   --collection <name>    Collection for --ingest (default: bookmarks)
 *   --api <url>            API URL for --ingest
 *   --update               With --ingest, pass --overwrite (re-import/update existing)
 *   -h, --help             Show this help
 */

/**
 * Walk a Chrome bookmarks node tree, collecting URL entries.
 * @param {object} node - A Chrome bookmarks JSON node
 * @param {string} folderPath - Accumulated folder path
 * @param {Array<{url: string, name: string, folder: string}>} result - Collected entries
 */
function walk(node, folderPath, result) {
  const type = node.type || "";
  const name = node.name || "";

  if (type === "folder") {
    const current = folderPath ? `${folderPath}/${name}` : name;
    for (const child of node.children || []) {
      walk(child, current, result);
    }
  } else if (type === "url") {
    const url = node.url || "";
    if (!url || url.startsWith("chrome://") || url.startsWith("chrome-extension://")) {
      return;
    }
    result.push({ url, name, folder: folderPath });
  }
}

/**
 * Extract bookmarks from a Chrome Bookmarks JSON file.
 *
 * @param {object} options
 * @param {string} [options.profile]  Chrome profile name (default: "Default")
 * @param {string} [options.folder]   Case-insensitive folder substring filter
 * @param {boolean} [options.withNames] Include bookmark names in output
 * @returns {{ lines: string[], total: number }}
 */
export function extractBookmarks({ profile = "Default", folder = "", withNames = false } = {}) {
  const bookmarksPath = join(
    homedir(),
    "Library",
    "Application Support",
    "Google",
    "Chrome",
    profile,
    "Bookmarks",
  );

  let raw;
  try {
    raw = readFileSync(bookmarksPath, "utf-8");
  } catch {
    throw new Error(
      `Chrome bookmarks file not found at: ${bookmarksPath}\n` +
      `Try --profile <ProfileName> if you use a non-default Chrome profile.`,
    );
  }

  const data = JSON.parse(raw);
  const roots = data.roots || {};
  const entries = [];

  for (const key of Object.keys(roots)) {
    if (roots[key] && typeof roots[key] === "object") {
      walk(roots[key], "", entries);
    }
  }

  // Filter by folder
  const lowerFolder = folder.toLowerCase();
  const filtered = lowerFolder
    ? entries.filter((e) => e.folder.toLowerCase().includes(lowerFolder))
    : entries;

  // Deduplicate by URL, keep first occurrence
  const seen = new Set();
  const unique = [];
  for (const entry of filtered) {
    if (!seen.has(entry.url)) {
      seen.add(entry.url);
      unique.push(entry);
    }
  }

  const lines = unique.map((e) =>
    withNames ? `${e.url}\t${e.name}` : e.url,
  );

  return { lines, total: unique.length };
}

// ── CLI entry point ─────────────────────────────────────────────
const entryArg = process.argv[1];
const entryUrl = entryArg ? pathToFileURL(resolve(entryArg)).href : "";
const isMain = import.meta.url === entryUrl;

if (isMain) {
  const args = process.argv.slice(2);
  let output = "";
  let folder = "";
  let withNames = false;
  let profile = "Default";
  let ingest = false;
  let collection = "bookmarks";
  let api = "";
  let update = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "-o":
      case "--output":
        output = args[++i];
        break;
      case "-f":
      case "--folder":
        folder = args[++i];
        break;
      case "--with-names":
        withNames = true;
        break;
      case "--profile":
        profile = args[++i];
        break;
      case "--ingest":
        ingest = true;
        break;
      case "--collection":
        collection = args[++i];
        break;
      case "--api":
        api = args[++i];
        break;
      case "--update":
        update = true;
        break;
      case "-h":
      case "--help":
        console.log(`Usage: node extract-chrome-bookmarks.mjs [OPTIONS]

Options:
  -o, --output <file>   Write URLs to file (default: stdout)
  -f, --folder <name>   Only from this folder (case-insensitive substring)
  --with-names           Output "URL\\tName" format
  --profile <name>       Chrome profile directory (default: Default)
  --ingest               Run raged ingest --urls-file after extraction
  --collection <name>    Collection for --ingest (default: bookmarks)
  --api <url>            API URL for --ingest
  --update               With --ingest, pass --overwrite
  -h, --help             Show this help

Output can be fed to: raged ingest --urls-file <file> --url-check`);
        process.exit(0);
        break;
      default:
        console.error(`Unknown option: ${args[i]}`);
        process.exit(1);
    }
  }

  try {
    if (update && !ingest) {
      console.error("--update requires --ingest (it maps to raged ingest --overwrite)");
      process.exit(1);
    }

    if (ingest && withNames) {
      console.error("--with-names is incompatible with --ingest (ingest expects URL-only lines)");
      process.exit(1);
    }

    const { lines, total } = extractBookmarks({ profile, folder, withNames });
    const text = lines.join("\n") + (lines.length ? "\n" : "");

    let outputPath = output;
    if (ingest && !outputPath) {
      outputPath = "/tmp/raged-bookmarks.txt";
    }

    if (outputPath) {
      writeFileSync(outputPath, text, "utf-8");
      console.error(`Wrote ${total} URLs to ${outputPath}`);
    } else {
      process.stdout.write(text);
      console.error(`# Total: ${total} unique bookmarks`);
    }

    if (ingest) {
      const ingestArgs = ["ingest", "--urls-file", outputPath, "--collection", collection];
      if (api) {
        ingestArgs.push("--api", api);
      }
      if (update) {
        ingestArgs.push("--overwrite");
      }

      const result = spawnSync("raged", ingestArgs, { stdio: "inherit" });
      if (result.status !== 0) {
        process.exit(result.status ?? 1);
      }
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
