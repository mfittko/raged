import type { IngestItem } from "../doctype.js";

export interface CodeMetadata {
  lang?: string;
  functions?: string[];
  classes?: string[];
  imports?: string[];
  exports?: string[];
  [key: string]: unknown;
}

const extToLang: Record<string, string> = {
  ".js": "javascript",
  ".jsx": "javascript",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".c": "c",
  ".cpp": "cpp",
  ".h": "c",
  ".hpp": "cpp",
  ".cs": "csharp",
  ".rb": "ruby",
  ".php": "php",
  ".swift": "swift",
  ".kt": "kotlin",
  ".scala": "scala",
  ".clj": "clojure",
  ".sh": "bash",
  ".bash": "bash",
  ".sql": "sql",
};

export function extractCode(item: IngestItem): CodeMetadata {
  const result: CodeMetadata = {};
  
  // Extract language from file extension
  const source = item.source;
  if (source) {
    const extMatch = source.match(/\.([a-z0-9]+)$/i);
    if (extMatch) {
      const ext = "." + extMatch[1].toLowerCase();
      result.lang = extToLang[ext] || ext.substring(1);
    }
  }

  // Simple regex-based extraction for common patterns
  // (This is a simplified version; full implementation would use Tree-sitter)
  const text = item.text;
  
  // Early return if no text available
  if (!text) {
    return result;
  }
  
  const MAX_EXTRACTIONS = 100;

  // Extract function names
  const functions: string[] = [];
  const functionPatterns = [
    /function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g, // JS/TS
    /def\s+([a-zA-Z_][a-zA-Z0-9_]*)/g, // Python
    /func\s+([a-zA-Z_][a-zA-Z0-9_]*)/g, // Go
    /fn\s+([a-zA-Z_][a-zA-Z0-9_]*)/g, // Rust
  ];
  for (const pattern of functionPatterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      functions.push(match[1]);
      if (functions.length >= MAX_EXTRACTIONS) break;
    }
    if (functions.length >= MAX_EXTRACTIONS) break;
  }
  if (functions.length > 0) {
    result.functions = [...new Set(functions)].slice(0, MAX_EXTRACTIONS);
  }

  // Extract class names
  const classes: string[] = [];
  const classPatterns = [
    /class\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g, // JS/TS/Java/C#
    /struct\s+([a-zA-Z_][a-zA-Z0-9_]*)/g, // Go/Rust/C
  ];
  for (const pattern of classPatterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      classes.push(match[1]);
      if (classes.length >= MAX_EXTRACTIONS) break;
    }
    if (classes.length >= MAX_EXTRACTIONS) break;
  }
  if (classes.length > 0) {
    result.classes = [...new Set(classes)].slice(0, MAX_EXTRACTIONS);
  }

  // Extract imports
  const imports: string[] = [];
  const importPatterns = [
    /import\s+.*?from\s+['"]([^'"]+)['"]/g, // JS/TS
    /import\s+['"]([^'"]+)['"]/g, // JS/TS
    /import\s+([a-zA-Z_][a-zA-Z0-9_.]*)/g, // Python/Go
  ];
  for (const pattern of importPatterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      imports.push(match[1]);
      if (imports.length >= MAX_EXTRACTIONS) break;
    }
    if (imports.length >= MAX_EXTRACTIONS) break;
  }
  if (imports.length > 0) {
    result.imports = [...new Set(imports)].slice(0, MAX_EXTRACTIONS);
  }

  // Extract exports
  const exports: string[] = [];
  const exportPatterns = [
    /export\s+(?:const|let|var|function|class)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g,
    /export\s+\{\s*([^}]+)\s*\}/g,
  ];
  for (const pattern of exportPatterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const names = match[1].split(",").map((s) => s.trim());
      exports.push(...names);
      if (exports.length >= MAX_EXTRACTIONS) break;
    }
    if (exports.length >= MAX_EXTRACTIONS) break;
  }
  if (exports.length > 0) {
    result.exports = [...new Set(exports)].slice(0, MAX_EXTRACTIONS);
  }

  return result;
}
