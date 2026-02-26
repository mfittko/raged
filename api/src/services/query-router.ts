/**
 * Query intent router: three-tier classification for POST /query.
 *
 * Tier 1 — Explicit override: request.strategy set by caller.
 * Tier 2 — Deterministic rule engine: pattern-based, high-confidence.
 * Tier 3 — LLM fallback: Ollama /api/generate or OpenAI chat completions.
 *
 * Circuit breaker prevents cascading LLM failures.
 */

export type QueryStrategy = "semantic" | "metadata" | "graph" | "hybrid";
export type RoutingMethod =
  | "explicit"
  | "rule"
  | "llm"
  | "rule_fallback"
  | "default";

export interface RoutingResult {
  strategy: QueryStrategy;
  method: RoutingMethod;
  confidence: number;
  rule?: string;
  durationMs: number;
  /** Set to true when LLM filter extraction inferred and applied a FilterDSL. */
  inferredFilter?: boolean;
}

export interface RouterRequest {
  query?: string;
  filter?: Record<string, unknown>;
  graphExpand?: boolean;
  strategy?: string;
}

// ---------------------------------------------------------------------------
// Configuration (from env vars)
// ---------------------------------------------------------------------------

function getLlmEnabled(): boolean {
  const val = process.env.ROUTER_LLM_ENABLED;
  return val !== "false";
}

function getLlmModel(): string {
  return process.env.ROUTER_LLM_MODEL || "llama3";
}

function getLlmTimeoutMs(): number {
  const val = process.env.ROUTER_LLM_TIMEOUT_MS;
  if (val) {
    const parsed = Number.parseInt(val, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 2000;
}

function getLlmCircuitBreakMs(): number {
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
// Circuit breaker (module-level singleton)
// ---------------------------------------------------------------------------

type CircuitState = "closed" | "open" | "half-open";

interface CircuitBreaker {
  state: CircuitState;
  failures: number;
  openedAt: number | null;
}

const FAILURE_THRESHOLD = 5;

// Exported for testing purposes only
export const _circuitBreaker: CircuitBreaker = {
  state: "closed",
  failures: 0,
  openedAt: null,
};

export function _resetCircuitBreaker(): void {
  _circuitBreaker.state = "closed";
  _circuitBreaker.failures = 0;
  _circuitBreaker.openedAt = null;
}

function isCircuitOpen(): boolean {
  if (_circuitBreaker.state === "closed") return false;
  if (_circuitBreaker.state === "open") {
    const cooldown = getLlmCircuitBreakMs();
    if (
      _circuitBreaker.openedAt !== null &&
      Date.now() - _circuitBreaker.openedAt >= cooldown
    ) {
      _circuitBreaker.state = "half-open";
      return false; // allow probe
    }
    return true;
  }
  // half-open → allow probe
  return false;
}

function recordLlmFailure(): void {
  if (_circuitBreaker.state === "half-open") {
    _circuitBreaker.state = "open";
    _circuitBreaker.openedAt = Date.now();
    _circuitBreaker.failures = FAILURE_THRESHOLD;
    return;
  }
  _circuitBreaker.failures += 1;
  if (_circuitBreaker.failures >= FAILURE_THRESHOLD) {
    _circuitBreaker.state = "open";
    _circuitBreaker.openedAt = Date.now();
  }
}

function recordLlmSuccess(): void {
  _circuitBreaker.state = "closed";
  _circuitBreaker.failures = 0;
  _circuitBreaker.openedAt = null;
}

// ---------------------------------------------------------------------------
// Rule engine
// ---------------------------------------------------------------------------

// Regex patterns for heuristic rules (rules 5–7)
// Rule 5 — entity pattern: "who/what/which is …" OR PascalCase identifier
const ENTITY_PATTERN =
  /^(?:who|what|which)\s+(?:is|are)\b|(?:^|\s)[A-Z][a-z]+(?:[A-Z][a-z]+)+/;
// Rule 6 — filter-like pattern: "show/list/find all … in/from/of"
const FILTER_LIKE_PATTERN =
  /^(?:show|list|find)\s+(?:all\s+)?.+?\s+(?:in|from|of)\b/i;
// Rule 7 — relational pattern
const RELATIONAL_PATTERN =
  /\b(?:related to|connected to|depends on|references)\b/i;

interface RuleMatch {
  strategy: QueryStrategy;
  confidence: number;
  rule: string;
}

function evaluateRules(req: RouterRequest): RuleMatch | null {
  const query = req.query ?? "";
  const hasFilter =
    req.filter !== undefined &&
    req.filter !== null &&
    typeof req.filter === "object";
  const hasGraphExpand = req.graphExpand === true;
  const wordCount = query.trim().split(/\s+/).filter((t) => t.length > 0)
    .length;

  // Rule 2: filter + short query + no graphExpand → metadata (conf 1.0)
  if (hasFilter && wordCount <= 3 && !hasGraphExpand) {
    return { strategy: "metadata", confidence: 1.0, rule: "filter_short_query" };
  }

  // Rule 3: graphExpand only (no filter) → graph (conf 1.0)
  if (hasGraphExpand && !hasFilter) {
    return { strategy: "graph", confidence: 1.0, rule: "graph_expand" };
  }

  // Rule 4: graphExpand + filter → hybrid (conf 1.0)
  if (hasGraphExpand && hasFilter) {
    return { strategy: "hybrid", confidence: 1.0, rule: "graph_expand_filter" };
  }

  // Rule 8: empty/absent query + filter → metadata (conf 1.0)
  if (hasFilter && query.trim().length === 0) {
    return { strategy: "metadata", confidence: 1.0, rule: "empty_query_filter" };
  }

  if (query.trim().length === 0) {
    return null;
  }

  // Rule 5: entity pattern → graph (conf 0.7)
  if (ENTITY_PATTERN.test(query)) {
    return { strategy: "graph", confidence: 0.7, rule: "entity_pattern" };
  }

  // Rule 6: filter-like pattern → metadata (conf 0.6)
  if (FILTER_LIKE_PATTERN.test(query)) {
    return { strategy: "metadata", confidence: 0.6, rule: "filter_like_pattern" };
  }

  // Rule 7: relational pattern → hybrid (conf 0.6)
  if (RELATIONAL_PATTERN.test(query)) {
    return { strategy: "hybrid", confidence: 0.6, rule: "relational_pattern" };
  }

  return null;
}

// ---------------------------------------------------------------------------
// LLM classifier
// ---------------------------------------------------------------------------

const VALID_STRATEGIES: ReadonlySet<string> = new Set([
  "semantic",
  "metadata",
  "graph",
  "hybrid",
]);

interface LlmClassification {
  strategy: QueryStrategy;
  confidence: number;
}

async function classifyWithLlm(
  query: string,
): Promise<LlmClassification | null> {
  const timeoutMs = getLlmTimeoutMs();
  const controller = new AbortController();
  const timerId = setTimeout(() => controller.abort(), timeoutMs);

  const prompt = `Classify the following search query into one of these strategies: semantic, metadata, graph, hybrid.

- semantic: general natural language questions or conceptual queries
- metadata: queries filtering by attributes, tags, or structured fields
- graph: queries about entities, relationships, or "who/what is X"
- hybrid: queries combining entity relationships with attribute filters

Respond ONLY with valid JSON: {"strategy": "<value>", "confidence": <0.0-1.0>}

Query: "${query.replace(/"/g, '\\"')}"`;

  try {
    const provider = getEmbedProvider();
    let response: Response;

    if (provider === "openai") {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) throw new Error("OPENAI_API_KEY required for LLM routing");
      const model =
        process.env.ROUTER_LLM_MODEL ||
        process.env.OPENAI_CHAT_MODEL ||
        "gpt-4o-mini";
      response = await fetch(`${getOpenAiBaseUrl()}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
          temperature: 0,
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
      const parsed = parseClassificationResponse(content);
      if (!parsed) {
        recordLlmFailure();
      }
      return parsed;
    } else {
      // Default: Ollama /api/generate
      const model = getLlmModel();
      response = await fetch(`${getOllamaUrl()}/api/generate`, {
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
      const parsed = parseClassificationResponse(json.response ?? "");
      if (!parsed) {
        recordLlmFailure();
      }
      return parsed;
    }
  } catch (err) {
    clearTimeout(timerId);
    recordLlmFailure();
    return null;
  }
}

function parseClassificationResponse(
  text: string,
): LlmClassification | null {
  try {
    const jsonText = extractFirstJsonObject(text);
    if (!jsonText) return null;
    const parsed = JSON.parse(jsonText) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const obj = parsed as Record<string, unknown>;
    const strategy = obj["strategy"];
    const confidence = obj["confidence"];
    if (typeof strategy !== "string" || !VALID_STRATEGIES.has(strategy))
      return null;
    if (typeof confidence !== "number" || confidence < 0 || confidence > 1)
      return null;
    return { strategy: strategy as QueryStrategy, confidence };
  } catch {
    return null;
  }
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

    if (inString) {
      continue;
    }

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

// ---------------------------------------------------------------------------
// Main classifier
// ---------------------------------------------------------------------------

export async function classifyQuery(req: RouterRequest): Promise<RoutingResult> {
  const start = Date.now();

  // Tier 1 — explicit override
  if (req.strategy !== undefined) {
    return {
      strategy: req.strategy as QueryStrategy,
      method: "explicit",
      confidence: 1.0,
      durationMs: Date.now() - start,
    };
  }

  // Tier 2 — deterministic rule engine
  const ruleMatch = evaluateRules(req);

  if (ruleMatch && ruleMatch.confidence >= 0.8) {
    return {
      strategy: ruleMatch.strategy,
      method: "rule",
      confidence: ruleMatch.confidence,
      rule: ruleMatch.rule,
      durationMs: Date.now() - start,
    };
  }

  // Tier 3 — LLM fallback (only for low-confidence rule matches)
  const llmEnabled = getLlmEnabled();
  if (ruleMatch && llmEnabled && !isCircuitOpen()) {
    const query = req.query ?? "";
    const llmResult = await classifyWithLlm(query);
    if (llmResult && llmResult.confidence >= 0.5) {
      recordLlmSuccess();
      return {
        strategy: llmResult.strategy,
        method: "llm",
        confidence: llmResult.confidence,
        rule: ruleMatch.rule,
        durationMs: Date.now() - start,
      };
    }
    // LLM failed or low confidence — fall back to rule result
    return {
      strategy: ruleMatch.strategy,
      method: "rule_fallback",
      confidence: ruleMatch.confidence,
      rule: ruleMatch.rule,
      durationMs: Date.now() - start,
    };
  }

  // If there's a low-confidence rule match but LLM is disabled/open
  if (ruleMatch) {
    return {
      strategy: ruleMatch.strategy,
      method: "rule_fallback",
      confidence: ruleMatch.confidence,
      rule: ruleMatch.rule,
      durationMs: Date.now() - start,
    };
  }

  // Default: semantic
  return {
    strategy: "semantic",
    method: "default",
    confidence: 1.0,
    durationMs: Date.now() - start,
  };
}
