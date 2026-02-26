/**
 * LLM-based structured filter extraction for natural language queries.
 *
 * Feature-flagged fallback that extracts FilterDSL conditions from free-form
 * query text when deterministic routing rules are ambiguous.
 *
 * All LLM output is treated as untrusted input and validated through
 * translateFilter before use. Never executes raw LLM-supplied SQL.
 */

import type { FilterDSL } from "../pg-helpers.js";
import { translateFilter, FilterValidationError } from "../pg-helpers.js";
import type { QueryStrategy } from "./query-router.js";

export interface FilterParserRequest {
  query: string;
  strategy: QueryStrategy;
  existingFilter?: FilterDSL | Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function getFilterLlmEnabled(): boolean {
  return process.env.ROUTER_FILTER_LLM_ENABLED === "true";
}

/** Returns true when the ROUTER_FILTER_LLM_ENABLED feature flag is active. */
export function isFilterLlmEnabled(): boolean {
  return getFilterLlmEnabled();
}

function getFilterLlmModel(): string {
  if (process.env.ROUTER_FILTER_LLM_MODEL) {
    return process.env.ROUTER_FILTER_LLM_MODEL;
  }
  return getEmbedProvider() === "openai" ? "gpt-4o-mini" : "llama3";
}

function getFilterLlmTimeoutMs(): number {
  const val = process.env.ROUTER_FILTER_LLM_TIMEOUT_MS;
  if (val) {
    const parsed = Number.parseInt(val, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 1500;
}

function getFilterLlmCircuitBreakMs(): number {
  const val = process.env.ROUTER_LLM_CIRCUIT_BREAK_MS;
  if (val) {
    const parsed = Number.parseInt(val, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 30_000;
}

function getEmbedProvider(): string {
  return process.env.EMBED_PROVIDER || "ollama";
}

function getOllamaUrl(): string {
  return process.env.OLLAMA_URL || "http://localhost:11434";
}

function getOpenAiBaseUrl(): string {
  return (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(
    /\/+$/,
    "",
  );
}

// ---------------------------------------------------------------------------
// Circuit breaker (dedicated for filter parser, same defaults as router)
// ---------------------------------------------------------------------------

type CircuitState = "closed" | "open" | "half-open";

interface CircuitBreaker {
  state: CircuitState;
  failures: number;
  openedAt: number | null;
}

const FAILURE_THRESHOLD = 5;

export const _filterParserCircuitBreaker: CircuitBreaker = {
  state: "closed",
  failures: 0,
  openedAt: null,
};

export function _resetFilterParserCircuitBreaker(): void {
  _filterParserCircuitBreaker.state = "closed";
  _filterParserCircuitBreaker.failures = 0;
  _filterParserCircuitBreaker.openedAt = null;
}

function isCircuitOpen(): boolean {
  if (_filterParserCircuitBreaker.state === "closed") return false;
  if (_filterParserCircuitBreaker.state === "open") {
    const cooldown = getFilterLlmCircuitBreakMs();
    if (
      _filterParserCircuitBreaker.openedAt !== null &&
      Date.now() - _filterParserCircuitBreaker.openedAt >= cooldown
    ) {
      _filterParserCircuitBreaker.state = "half-open";
      return false;
    }
    return true;
  }
  // half-open → allow probe
  return false;
}

function recordParserFailure(): void {
  if (_filterParserCircuitBreaker.state === "half-open") {
    _filterParserCircuitBreaker.state = "open";
    _filterParserCircuitBreaker.openedAt = Date.now();
    _filterParserCircuitBreaker.failures = FAILURE_THRESHOLD;
    return;
  }
  _filterParserCircuitBreaker.failures += 1;
  if (_filterParserCircuitBreaker.failures >= FAILURE_THRESHOLD) {
    _filterParserCircuitBreaker.state = "open";
    _filterParserCircuitBreaker.openedAt = Date.now();
  }
}

function recordParserSuccess(): void {
  _filterParserCircuitBreaker.state = "closed";
  _filterParserCircuitBreaker.failures = 0;
  _filterParserCircuitBreaker.openedAt = null;
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const FILTER_EXTRACTION_PROMPT = `Extract structured filter conditions from the following search query.
Return ONLY valid JSON matching the FilterDSL schema. If no filters can be extracted, return the literal null.

Available fields and allowed operators:
- docType: document type string (ops: eq, ne, in, notIn)
- repoId: repository identifier string (ops: eq, ne, in, notIn)
- lang: programming language code — use short codes only: "ts" (TypeScript), "js" (JavaScript), "py" (Python), "go" (Go), "rs" (Rust), "java" (Java), "rb" (Ruby), "cpp" (C++) (ops: eq, ne, in, notIn)
- path: file path prefix string (ops: eq, ne, in, notIn)
- mimeType: MIME type string (ops: eq, ne, in, notIn)
- ingestedAt: ingestion timestamp ISO 8601 date string, e.g. "2023-01-01" (ops: eq, ne, gt, gte, lt, lte, between, notBetween, in, notIn, isNull, isNotNull)
- createdAt: creation timestamp ISO 8601 date string (ops: eq, ne, gt, gte, lt, lte, between, notBetween, in, notIn, isNull, isNotNull)
- updatedAt: last update timestamp ISO 8601 date string (ops: eq, ne, gt, gte, lt, lte, between, notBetween, in, notIn, isNull, isNotNull)

FilterDSL schema:
{
  "conditions": [
    { "field": "<fieldName>", "op": "<operator>", "value": "<scalar>" }
    | { "field": "<fieldName>", "op": "in"|"notIn", "values": ["<v1>", "<v2>"] }
    | { "field": "<fieldName>", "op": "between"|"notBetween", "range": { "low": "<v1>", "high": "<v2>" } }
  ],
  "combine": "and" | "or"
}

Examples:
- "all typescript files from 2023" → {"conditions":[{"field":"lang","op":"eq","value":"ts"},{"field":"ingestedAt","op":"between","range":{"low":"2023-01-01","high":"2023-12-31"}}],"combine":"and"}
- "python or javascript code" → {"conditions":[{"field":"lang","op":"in","values":["py","js"]}],"combine":"and"}
- "openai invoices from 2023 and 2024" → {"conditions":[{"field":"ingestedAt","op":"between","range":{"low":"2023-01-01","high":"2024-12-31"}}],"combine":"and"}
- "documents ingested after 2024-06-01" → {"conditions":[{"field":"ingestedAt","op":"gte","value":"2024-06-01"}],"combine":"and"}
- "how does authentication work" → null

Respond ONLY with valid JSON (the FilterDSL object) or the literal null.
Query: "`;

/**
 * OpenAI-specific system prompt. When using structured output (json_schema
 * response_format), the model cannot return the literal `null` token — instead
 * it must return a valid object. An empty `conditions` array signals "no
 * applicable filters" and is handled identically to a null response.
 */
const OPENAI_SYSTEM_PROMPT = `You are a structured filter extractor. Given a natural-language search query, output a FilterDSL JSON object that captures any explicit attribute or temporal constraints.

Available fields and allowed operators:
- docType: document type string (ops: eq, ne, in, notIn)
- repoId: repository identifier string (ops: eq, ne, in, notIn)
- lang: programming language code — use short codes only: "ts" (TypeScript), "js" (JavaScript), "py" (Python), "go" (Go), "rs" (Rust), "java" (Java), "rb" (Ruby), "cpp" (C++) (ops: eq, ne, in, notIn)
- path: file path prefix string (ops: eq, ne, in, notIn)
- mimeType: MIME type string (ops: eq, ne, in, notIn)
- ingestedAt: ingestion timestamp ISO 8601 date string, e.g. "2023-01-01" (ops: eq, ne, gt, gte, lt, lte, between, notBetween, in, notIn, isNull, isNotNull)
- createdAt: creation timestamp ISO 8601 date string (ops: eq, ne, gt, gte, lt, lte, between, notBetween, in, notIn, isNull, isNotNull)
- updatedAt: last update timestamp ISO 8601 date string (ops: eq, ne, gt, gte, lt, lte, between, notBetween, in, notIn, isNull, isNotNull)

Rules:
- Use an empty conditions array when no filter constraints are present in the query.
- Always output "combine": "and" or "combine": "or" (use "and" when unsure).
- Use scalar conditions for single-value comparisons, range conditions for temporal spans, and list conditions for sets.

Examples:
- "all typescript files from 2023" → {"conditions":[{"field":"lang","op":"eq","value":"ts"},{"field":"ingestedAt","op":"between","range":{"low":"2023-01-01","high":"2023-12-31"}}],"combine":"and"}
- "python or javascript code" → {"conditions":[{"field":"lang","op":"in","values":["py","js"]}],"combine":"and"}
- "openai invoices from 2023 and 2024" → {"conditions":[{"field":"ingestedAt","op":"between","range":{"low":"2023-01-01","high":"2024-12-31"}}],"combine":"and"}
- "how does authentication work" → {"conditions":[],"combine":"and"}`;

const ALLOWED_FIELDS = [
  "docType",
  "repoId",
  "lang",
  "path",
  "mimeType",
  "ingestedAt",
  "createdAt",
  "updatedAt",
] as const;

/**
 * JSON Schema for FilterDSL used with OpenAI structured output.
 * Conditions are a discriminated union keyed on `op`.
 */
const FILTER_DSL_JSON_SCHEMA = {
  type: "object",
  required: ["conditions", "combine"],
  additionalProperties: false,
  properties: {
    conditions: {
      type: "array",
      items: {
        anyOf: [
          {
            type: "object",
            required: ["field", "op", "value"],
            additionalProperties: false,
            properties: {
              field: { type: "string", enum: ALLOWED_FIELDS },
              op: {
                type: "string",
                enum: ["eq", "ne", "gt", "gte", "lt", "lte", "isNull", "isNotNull"],
              },
              value: { type: "string" },
            },
          },
          {
            type: "object",
            required: ["field", "op", "values"],
            additionalProperties: false,
            properties: {
              field: { type: "string", enum: ALLOWED_FIELDS },
              op: { type: "string", enum: ["in", "notIn"] },
              values: { type: "array", items: { type: "string" } },
            },
          },
          {
            type: "object",
            required: ["field", "op", "range"],
            additionalProperties: false,
            properties: {
              field: { type: "string", enum: ALLOWED_FIELDS },
              op: { type: "string", enum: ["between", "notBetween"] },
              range: {
                type: "object",
                required: ["low", "high"],
                additionalProperties: false,
                properties: {
                  low: { type: "string" },
                  high: { type: "string" },
                },
              },
            },
          },
        ],
      },
    },
    combine: { type: "string", enum: ["and", "or"] },
  },
} as const;

// ---------------------------------------------------------------------------
// LLM call and response parsing
// ---------------------------------------------------------------------------

/**
 * Parses and validates the raw LLM text response.
 * Returns FilterDSL on success, null if no filters apply, throws on invalid output.
 */
function parseAndValidateFilterResponse(text: string): FilterDSL | null {
  const trimmed = text.trim();
  if (trimmed === "null" || trimmed === "") return null;

  const jsonText = extractFirstJsonObject(trimmed);
  if (!jsonText) {
    throw new Error("Filter parser returned non-JSON response");
  }

  const parsed = JSON.parse(jsonText) as unknown;
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Filter parser returned non-object JSON");
  }

  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj["conditions"])) {
    throw new Error("Filter parser output missing conditions array");
  }

  const candidate = obj as unknown as FilterDSL;

  // Validate through translateFilter — throws FilterValidationError on unknown field/operator
  try {
    translateFilter(candidate, 0);
  } catch (err) {
    if (err instanceof FilterValidationError) {
      throw new Error(`Filter parser output failed validation: ${err.message}`);
    }
    throw err;
  }

  return candidate;
}

function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escapeNext = false;

  for (let index = start; index < text.length; index++) {
    const char = text[index];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (char === "\\") {
      escapeNext = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }

  return null;
}

/**
 * Calls the LLM to extract filter conditions.
 * Returns FilterDSL on success, null if LLM indicates no applicable filters.
 * Throws on network/HTTP/parse errors.
 */
async function callLlm(query: string): Promise<FilterDSL | null> {
  const timeoutMs = getFilterLlmTimeoutMs();
  const controller = new AbortController();
  const timerId = setTimeout(() => controller.abort(), timeoutMs);

  // JSON.stringify produces a properly escaped JSON string including the quotes;
  // strip the outer quotes since the prompt template already provides them.
  const escapedQuery = JSON.stringify(query).slice(1, -1);
  const prompt = `${FILTER_EXTRACTION_PROMPT}${escapedQuery}"`;

  try {
    const provider = getEmbedProvider();

    if (provider === "openai") {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) throw new Error("OPENAI_API_KEY required for LLM filter extraction");
      const model = getFilterLlmModel();
      const response = await fetch(`${getOpenAiBaseUrl()}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: OPENAI_SYSTEM_PROMPT },
            { role: "user", content: `Query: "${escapedQuery}"` },
          ],
          temperature: 0,
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "filter_dsl",
              strict: true,
              schema: FILTER_DSL_JSON_SCHEMA,
            },
          },
        }),
        signal: controller.signal,
      });
      clearTimeout(timerId);
      if (!response.ok) {
        throw new Error(`OpenAI chat completions failed: ${response.status}`);
      }
      const json = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = json.choices?.[0]?.message?.content ?? "";
      return parseAndValidateFilterResponse(content);
    } else {
      // Default: Ollama /api/generate
      const model = getFilterLlmModel();
      const response = await fetch(`${getOllamaUrl()}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, prompt, stream: false }),
        signal: controller.signal,
      });
      clearTimeout(timerId);
      if (!response.ok) {
        throw new Error(`Ollama generate failed: ${response.status}`);
      }
      const json = (await response.json()) as { response?: string };
      return parseAndValidateFilterResponse(json.response ?? "");
    }
  } catch (err) {
    clearTimeout(timerId);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Attempts to extract a structured FilterDSL from a natural language query
 * using an LLM. Returns null if:
 * - Feature flag `ROUTER_FILTER_LLM_ENABLED` is not `"true"`
 * - Circuit breaker is open (too many recent failures)
 * - Query is empty
 * - LLM indicates no applicable filters
 * - LLM output fails schema or field/operator validation
 *
 * Never throws — all errors produce a null return and are logged.
 * All LLM output is validated through translateFilter before returning.
 */
export async function extractStructuredFilter(
  request: FilterParserRequest,
): Promise<FilterDSL | null> {
  if (!getFilterLlmEnabled()) return null;
  if (isCircuitOpen()) return null;
  if (!request.query || request.query.trim().length === 0) return null;

  const parseStart = Date.now();

  try {
    const result = await callLlm(request.query);
    const latencyMs = Date.now() - parseStart;

    if (result === null || result.conditions.length === 0) {
      // LLM responded cleanly but found no filters — still a successful call;
      // reset breaker so prior failures don't accumulate across clean responses.
      recordParserSuccess();
      console.log(
        JSON.stringify({
          event: "filter_parser",
          status: "no_filter",
          strategy: request.strategy,
          latencyMs,
        }),
      );
      return null;
    }

    recordParserSuccess();
    console.log(
      JSON.stringify({
        event: "filter_parser",
        status: "success",
        strategy: request.strategy,
        conditionCount: result.conditions.length,
        latencyMs,
      }),
    );
    return result;
  } catch (err) {
    const latencyMs = Date.now() - parseStart;
    recordParserFailure();
    console.log(
      JSON.stringify({
        event: "filter_parser",
        status: "error",
        strategy: request.strategy,
        errorType: err instanceof Error ? err.name : "unknown",
        latencyMs,
      }),
    );
    return null;
  }
}
