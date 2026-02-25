import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  classifyQuery,
  _resetCircuitBreaker,
  _circuitBreaker,
} from "./query-router.js";
import type { RouterRequest } from "./query-router.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

beforeEach(() => {
  _resetCircuitBreaker();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// Rule engine tests
// ---------------------------------------------------------------------------

describe("classifyQuery — rule engine", () => {
  it("explicit override: strategy param short-circuits everything", async () => {
    const result = await classifyQuery({ query: "hello", strategy: "graph" });
    expect(result.strategy).toBe("graph");
    expect(result.method).toBe("explicit");
    expect(result.confidence).toBe(1.0);
  });

  it("rule 2: filter + short query (≤3 words) + no graphExpand → metadata conf 1.0", async () => {
    const req: RouterRequest = {
      query: "typescript",
      filter: { docType: "code" },
    };
    vi.stubEnv("ROUTER_LLM_ENABLED", "false");
    const result = await classifyQuery(req);
    expect(result.strategy).toBe("metadata");
    expect(result.confidence).toBe(1.0);
    expect(result.method).toBe("rule");
  });

  it("rule 3: graphExpand only (no filter) → graph conf 1.0", async () => {
    vi.stubEnv("ROUTER_LLM_ENABLED", "false");
    const result = await classifyQuery({ query: "auth", graphExpand: true });
    expect(result.strategy).toBe("graph");
    expect(result.confidence).toBe(1.0);
    expect(result.method).toBe("rule");
  });

  it("rule 4: graphExpand + filter → hybrid conf 1.0", async () => {
    vi.stubEnv("ROUTER_LLM_ENABLED", "false");
    const result = await classifyQuery({
      query: "auth",
      graphExpand: true,
      filter: { docType: "code" },
    });
    expect(result.strategy).toBe("hybrid");
    expect(result.confidence).toBe(1.0);
    expect(result.method).toBe("rule");
  });

  it("rule 5: entity pattern 'who is AuthService' → graph conf 0.7", async () => {
    vi.stubEnv("ROUTER_LLM_ENABLED", "false");
    const result = await classifyQuery({ query: "who is AuthService" });
    expect(result.strategy).toBe("graph");
    expect(result.confidence).toBe(0.7);
  });

  it("rule 5: entity pattern PascalCase → graph conf 0.7", async () => {
    vi.stubEnv("ROUTER_LLM_ENABLED", "false");
    const result = await classifyQuery({ query: "AuthService dependencies" });
    expect(result.strategy).toBe("graph");
    expect(result.confidence).toBe(0.7);
  });

  it("rule 6: filter-like pattern 'show all files in repo' → metadata conf 0.6", async () => {
    vi.stubEnv("ROUTER_LLM_ENABLED", "false");
    const result = await classifyQuery({ query: "show all files in repo" });
    expect(result.strategy).toBe("metadata");
    expect(result.confidence).toBe(0.6);
  });

  it("rule 7: relational pattern 'related to AuthService' → hybrid conf 0.6", async () => {
    vi.stubEnv("ROUTER_LLM_ENABLED", "false");
    const result = await classifyQuery({ query: "related to AuthService" });
    expect(result.strategy).toBe("hybrid");
    expect(result.confidence).toBe(0.6);
  });

  it("rule 8: empty query + filter → metadata conf 1.0", async () => {
    vi.stubEnv("ROUTER_LLM_ENABLED", "false");
    const result = await classifyQuery({
      query: "",
      filter: { docType: "code" },
    });
    expect(result.strategy).toBe("metadata");
    expect(result.confidence).toBe(1.0);
    expect(result.method).toBe("rule");
  });

  it("rule 8: absent query + filter → metadata conf 1.0", async () => {
    vi.stubEnv("ROUTER_LLM_ENABLED", "false");
    const result = await classifyQuery({ filter: { docType: "code" } });
    expect(result.strategy).toBe("metadata");
    expect(result.confidence).toBe(1.0);
    expect(result.method).toBe("rule");
  });

  it("default: plain question → semantic conf 1.0", async () => {
    vi.stubEnv("ROUTER_LLM_ENABLED", "false");
    const result = await classifyQuery({ query: "how does auth work" });
    expect(result.strategy).toBe("semantic");
    expect(result.confidence).toBe(1.0);
    expect(result.method).toBe("default");
  });

  it("rule 2 takes priority over rule 8 (filter + 0 words is covered by rule 8, but 1-3 word query hits rule 2)", async () => {
    vi.stubEnv("ROUTER_LLM_ENABLED", "false");
    // 1-word query + filter → rule 2
    const result = await classifyQuery({
      query: "auth",
      filter: { docType: "code" },
    });
    expect(result.strategy).toBe("metadata");
    expect(result.rule).toBe("filter_short_query");
  });

  it("returns durationMs as a non-negative number", async () => {
    vi.stubEnv("ROUTER_LLM_ENABLED", "false");
    const result = await classifyQuery({ query: "hello" });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(typeof result.durationMs).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// LLM fallback tests
// ---------------------------------------------------------------------------

describe("classifyQuery — LLM fallback", () => {
  it("uses LLM result when it returns valid JSON with conf ≥ 0.5", async () => {
    vi.stubEnv("ROUTER_LLM_ENABLED", "true");
    vi.stubEnv("OLLAMA_URL", "http://localhost:11434");

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ response: '{"strategy":"metadata","confidence":0.8}' }),
    } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    const result = await classifyQuery({ query: "who is AuthService" });
    expect(result.strategy).toBe("metadata");
    expect(result.method).toBe("llm");
    expect(result.confidence).toBe(0.8);
  });

  it("falls back to rule when LLM returns conf < 0.5", async () => {
    vi.stubEnv("ROUTER_LLM_ENABLED", "true");
    vi.stubEnv("OLLAMA_URL", "http://localhost:11434");

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ response: '{"strategy":"graph","confidence":0.3}' }),
    } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    const result = await classifyQuery({ query: "who is AuthService" });
    expect(result.method).toBe("rule_fallback");
    expect(result.strategy).toBe("graph"); // rule 5 → graph
  });

  it("falls back to rule when LLM returns unparseable response", async () => {
    vi.stubEnv("ROUTER_LLM_ENABLED", "true");
    vi.stubEnv("OLLAMA_URL", "http://localhost:11434");

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ response: "not json at all" }),
    } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    const result = await classifyQuery({ query: "who is AuthService" });
    expect(result.method).toBe("rule_fallback");
  });

  it("falls back when LLM times out (AbortController fires)", async () => {
    vi.stubEnv("ROUTER_LLM_ENABLED", "true");
    vi.stubEnv("OLLAMA_URL", "http://localhost:11434");
    vi.stubEnv("ROUTER_LLM_TIMEOUT_MS", "1"); // 1ms timeout

    const fetchMock = vi.fn().mockImplementation(
      () =>
        new Promise((_, reject) =>
          setTimeout(() => reject(new DOMException("Aborted", "AbortError")), 50),
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await classifyQuery({ query: "who is AuthService" });
    expect(result.method).toBe("rule_fallback");
  });

  it("ROUTER_LLM_ENABLED=false never calls LLM", async () => {
    vi.stubEnv("ROUTER_LLM_ENABLED", "false");

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await classifyQuery({ query: "who is AuthService" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("LLM returns unknown strategy value → falls back", async () => {
    vi.stubEnv("ROUTER_LLM_ENABLED", "true");
    vi.stubEnv("OLLAMA_URL", "http://localhost:11434");

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        response: '{"strategy":"unknown_strategy","confidence":0.9}',
      }),
    } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    const result = await classifyQuery({ query: "who is AuthService" });
    expect(result.method).toBe("rule_fallback");
  });
});

// ---------------------------------------------------------------------------
// Circuit breaker tests
// ---------------------------------------------------------------------------

describe("classifyQuery — circuit breaker", () => {
  it("stays closed after 4 consecutive failures", async () => {
    vi.stubEnv("ROUTER_LLM_ENABLED", "true");
    vi.stubEnv("OLLAMA_URL", "http://localhost:11434");

    const fetchMock = vi.fn().mockRejectedValue(new Error("Network error"));
    vi.stubGlobal("fetch", fetchMock);

    for (let i = 0; i < 4; i++) {
      await classifyQuery({ query: "who is AuthService" });
    }
    expect(_circuitBreaker.state).toBe("closed");
    expect(_circuitBreaker.failures).toBe(4);
  });

  it("opens after 5th consecutive failure", async () => {
    vi.stubEnv("ROUTER_LLM_ENABLED", "true");
    vi.stubEnv("OLLAMA_URL", "http://localhost:11434");

    const fetchMock = vi.fn().mockRejectedValue(new Error("Network error"));
    vi.stubGlobal("fetch", fetchMock);

    for (let i = 0; i < 5; i++) {
      await classifyQuery({ query: "who is AuthService" });
    }
    expect(_circuitBreaker.state).toBe("open");
  });

  it("skips LLM call when circuit is open", async () => {
    vi.stubEnv("ROUTER_LLM_ENABLED", "true");
    vi.stubEnv("OLLAMA_URL", "http://localhost:11434");
    // Force open circuit
    _circuitBreaker.state = "open";
    _circuitBreaker.failures = 5;
    _circuitBreaker.openedAt = Date.now();

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await classifyQuery({ query: "who is AuthService" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.method).toBe("rule_fallback");
  });

  it("allows probe after cooldown elapses (half-open)", async () => {
    vi.stubEnv("ROUTER_LLM_ENABLED", "true");
    vi.stubEnv("OLLAMA_URL", "http://localhost:11434");
    vi.stubEnv("ROUTER_LLM_CIRCUIT_BREAK_MS", "1"); // 1ms cooldown

    _circuitBreaker.state = "open";
    _circuitBreaker.failures = 5;
    _circuitBreaker.openedAt = Date.now() - 100; // already elapsed

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ response: '{"strategy":"graph","confidence":0.9}' }),
    } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    const result = await classifyQuery({ query: "who is AuthService" });
    expect(fetchMock).toHaveBeenCalledTimes(1); // probe was allowed
    expect(result.method).toBe("llm");
  });

  it("closes circuit after successful probe", async () => {
    vi.stubEnv("ROUTER_LLM_ENABLED", "true");
    vi.stubEnv("OLLAMA_URL", "http://localhost:11434");
    vi.stubEnv("ROUTER_LLM_CIRCUIT_BREAK_MS", "1");

    _circuitBreaker.state = "open";
    _circuitBreaker.failures = 5;
    _circuitBreaker.openedAt = Date.now() - 100;

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ response: '{"strategy":"graph","confidence":0.9}' }),
    } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    await classifyQuery({ query: "who is AuthService" });
    expect(_circuitBreaker.state).toBe("closed");
    expect(_circuitBreaker.failures).toBe(0);
  });
});
