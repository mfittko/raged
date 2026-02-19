import fs from "node:fs/promises";
import path from "node:path";

function parseEnvValue(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";

  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    const inner = trimmed.slice(1, -1);
    if (trimmed.startsWith('"')) {
      return inner
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "\r")
        .replace(/\\t/g, "\t")
        .replace(/\\"/g, '"');
    }
    return inner;
  }

  const commentIndex = trimmed.indexOf(" #");
  return commentIndex >= 0 ? trimmed.slice(0, commentIndex).trim() : trimmed;
}

export async function loadDotEnvFromCwd(cwd: string = process.cwd()): Promise<void> {
  const envPath = path.join(cwd, ".env");

  let content: string;
  try {
    content = await fs.readFile(envPath, "utf8");
  } catch (error) {
    const maybeErr = error as NodeJS.ErrnoException;
    if (maybeErr.code === "ENOENT") {
      return;
    }
    throw error;
  }

  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const normalized = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(normalized);
    if (!match) {
      continue;
    }

    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) {
      continue;
    }

    process.env[key] = parseEnvValue(rawValue);
  }
}

export function getDefaultApiUrl(): string {
  const explicit = (process.env.RAGED_URL || "").trim();
  if (explicit) {
    return explicit;
  }

  const hostPort = (process.env.API_HOST_PORT || "").trim();
  if (/^[0-9]+$/.test(hostPort)) {
    return `http://localhost:${hostPort}`;
  }

  return "http://localhost:8080";
}
