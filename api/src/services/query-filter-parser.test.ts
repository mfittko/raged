import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  extractStructuredFilter,
  _resetFilterParserCircuitBreaker,
  _filterParserCircuitBreaker,
} from "./query-filter-parser.js";
import type { FilterParserRequest } from "./query-filter-parser.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(query: string): FilterParserRequest {
  return { query, strategy: "semantic" };
}

beforeEach(() => {
  _resetFilterParserCircuitBreaker();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// Feature flag
// ---------------------------------------------------------------------------

describe("extractStructuredFilter — feature flag", () => {
  it("returns null when ROUTER_FILTER_LLM_ENABLED is not set (default off)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await extractStructuredFilter(makeRequest("all typescript files from 2023"));
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns null when ROUTER_FILTER_LLM_ENABLED=false", async () => {
    vi.stubEnv("ROUTER_FILTER_LLM_ENABLED", "false");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await extractStructuredFilter(makeRequest("all typescript files"));
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("calls LLM when ROUTER_FILTER_LLM_ENABLED=true", async () => {
    vi.stubEnv("ROUTER_FILTER_LLM_ENABLED", "true");
    vi.stubEnv("OLLAMA_URL", "http://localhost:11434");

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ response: '{"conditions":[{"field":"lang","op":"eq","value":"ts"}],"combine":"and"}' }),
    } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    const result = await extractStructuredFilter(makeRequest("all typescript files"));
    expect(fetchMock).toHaveBeenCalled();
    expect(result).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Empty query guard
// ---------------------------------------------------------------------------

describe("extractStructuredFilter — empty query guard", () => {
  it("returns null for empty query", async () => {
    vi.stubEnv("ROUTER_FILTER_LLM_ENABLED", "true");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await extractStructuredFilter(makeRequest(""));
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns null for whitespace-only query", async () => {
    vi.stubEnv("ROUTER_FILTER_LLM_ENABLED", "true");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await extractStructuredFilter(makeRequest("   "));
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Successful filter extraction (Ollama)
// ---------------------------------------------------------------------------

describe("extractStructuredFilter — Ollama success cases", () => {
  beforeEach(() => {
    vi.stubEnv("ROUTER_FILTER_LLM_ENABLED", "true");
    vi.stubEnv("OLLAMA_URL", "http://localhost:11434");
    vi.stubEnv("EMBED_PROVIDER", "ollama");
  });

  it("returns FilterDSL for valid single-condition response", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        response: '{"conditions":[{"field":"lang","op":"eq","value":"ts"}],"combine":"and"}',
      }),
    } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    const result = await extractStructuredFilter(makeRequest("all typescript files"));
    expect(result).not.toBeNull();
    expect(result!.conditions).toHaveLength(1);
    expect(result!.conditions[0].field).toBe("lang");
    expect(result!.conditions[0].op).toBe("eq");
    expect(result!.conditions[0].value).toBe("ts");
  });

  it("handles temporal range query — between operator", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        response: JSON.stringify({
          conditions: [
            { field: "ingestedAt", op: "between", range: { low: "2023-01-01", high: "2023-12-31" } },
          ],
          combine: "and",
        }),
      }),
    } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    const result = await extractStructuredFilter(makeRequest("all invoices from 2023"));
    expect(result).not.toBeNull();
    expect(result!.conditions[0].field).toBe("ingestedAt");
    expect(result!.conditions[0].op).toBe("between");
    expect(result!.conditions[0].range).toEqual({ low: "2023-01-01", high: "2023-12-31" });
  });

  it("handles multi-constraint query — lang + ingestedAt", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        response: JSON.stringify({
          conditions: [
            { field: "lang", op: "eq", value: "ts" },
            { field: "ingestedAt", op: "between", range: { low: "2023-01-01", high: "2024-12-31" } },
          ],
          combine: "and",
        }),
      }),
    } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    const result = await extractStructuredFilter(
      makeRequest("all openai invoices from 2023 and 2024"),
    );
    expect(result).not.toBeNull();
    expect(result!.conditions).toHaveLength(2);
  });

  it("returns null when LLM responds with literal null", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ response: "null" }),
    } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    const result = await extractStructuredFilter(makeRequest("how does auth work"));
    expect(result).toBeNull();
  });

  it("returns null when LLM responds with empty conditions array", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ response: '{"conditions":[],"combine":"and"}' }),
    } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    const result = await extractStructuredFilter(makeRequest("general question"));
    expect(result).toBeNull();
  });

  it("sends prompt to Ollama /api/generate endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        response: '{"conditions":[{"field":"lang","op":"eq","value":"ts"}],"combine":"and"}',
      }),
    } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    await extractStructuredFilter(makeRequest("typescript files"));
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:11434/api/generate",
      expect.objectContaining({ method: "POST" }),
    );
  });
});

// ---------------------------------------------------------------------------
// Successful filter extraction (OpenAI)
// ---------------------------------------------------------------------------

describe("extractStructuredFilter — OpenAI success cases", () => {
  beforeEach(() => {
    vi.stubEnv("ROUTER_FILTER_LLM_ENABLED", "true");
    vi.stubEnv("EMBED_PROVIDER", "openai");
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    vi.stubEnv("OPENAI_BASE_URL", "https://api.openai.com/v1");
  });

  it("returns FilterDSL using OpenAI chat completions", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: '{"conditions":[{"field":"lang","op":"eq","value":"py"}],"combine":"and"}',
            },
          },
        ],
      }),
    } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    const result = await extractStructuredFilter(makeRequest("all python files"));
    expect(result).not.toBeNull();
    expect(result!.conditions[0].field).toBe("lang");
    expect(result!.conditions[0].value).toBe("py");
  });

  it("calls OpenAI /chat/completions endpoint with json_schema response_format", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: '{"conditions":[{"field":"lang","op":"eq","value":"py"}],"combine":"and"}',
            },
          },
        ],
      }),
    } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    await extractStructuredFilter(makeRequest("python files"));
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.openai.com/v1/chat/completions",
      expect.objectContaining({ method: "POST" }),
    );

    const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(requestInit.body as string) as {
      response_format: { type: string; json_schema: { name: string; strict: boolean } };
      messages: Array<{ role: string }>;
    };

    // Must use structured output format
    expect(body.response_format.type).toBe("json_schema");
    expect(body.response_format.json_schema.name).toBe("filter_dsl");
    expect(body.response_format.json_schema.strict).toBe(true);

    // Must use system + user message pattern
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[1].role).toBe("user");
  });

  it("treats empty conditions array from OpenAI as no-filter result", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: '{"conditions":[],"combine":"and"}',
            },
          },
        ],
      }),
    } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    const result = await extractStructuredFilter(makeRequest("how does authentication work"));
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Invalid / malformed output
// ---------------------------------------------------------------------------

describe("extractStructuredFilter — invalid output handling", () => {
  beforeEach(() => {
    vi.stubEnv("ROUTER_FILTER_LLM_ENABLED", "true");
    vi.stubEnv("OLLAMA_URL", "http://localhost:11434");
  });

  it("returns null for unparseable JSON response", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ response: "not json at all" }),
    } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    const result = await extractStructuredFilter(makeRequest("all typescript files"));
    expect(result).toBeNull();
  });

  it("returns null when response has unknown field", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        response: '{"conditions":[{"field":"bogusField","op":"eq","value":"x"}],"combine":"and"}',
      }),
    } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    const result = await extractStructuredFilter(makeRequest("some query"));
    expect(result).toBeNull();
  });

  it("returns null when response has disallowed operator for field", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        // docType only supports text ops (eq/ne/in/notIn), not gte
        response: '{"conditions":[{"field":"docType","op":"gte","value":"code"}],"combine":"and"}',
      }),
    } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    const result = await extractStructuredFilter(makeRequest("some query"));
    expect(result).toBeNull();
  });

  it("returns null when response is missing conditions array", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ response: '{"combine":"and"}' }),
    } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    const result = await extractStructuredFilter(makeRequest("some query"));
    expect(result).toBeNull();
  });

  it("returns null when response has JSON with extra LLM text before the object", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        response:
          'Here is the FilterDSL: {"conditions":[{"field":"lang","op":"eq","value":"ts"}],"combine":"and"} Done.',
      }),
    } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    const result = await extractStructuredFilter(makeRequest("typescript files"));
    expect(result).not.toBeNull();
    expect(result!.conditions[0].field).toBe("lang");
  });
});

// ---------------------------------------------------------------------------
// Timeout and network errors
// ---------------------------------------------------------------------------

describe("extractStructuredFilter — timeout / network errors", () => {
  beforeEach(() => {
    vi.stubEnv("ROUTER_FILTER_LLM_ENABLED", "true");
    vi.stubEnv("OLLAMA_URL", "http://localhost:11434");
    vi.stubEnv("ROUTER_FILTER_LLM_TIMEOUT_MS", "1");
  });

  it("returns null when LLM times out", async () => {
    const fetchMock = vi.fn().mockImplementation(
      () =>
        new Promise((_, reject) =>
          setTimeout(() => reject(new DOMException("Aborted", "AbortError")), 50),
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await extractStructuredFilter(makeRequest("all typescript files"));
    expect(result).toBeNull();
  });

  it("returns null when LLM request fails with network error", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("Network unreachable"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await extractStructuredFilter(makeRequest("all typescript files"));
    expect(result).toBeNull();
  });

  it("returns null when LLM returns HTTP error", async () => {
    vi.stubEnv("ROUTER_FILTER_LLM_TIMEOUT_MS", "5000");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    const result = await extractStructuredFilter(makeRequest("all typescript files"));
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------

describe("extractStructuredFilter — circuit breaker", () => {
  beforeEach(() => {
    vi.stubEnv("ROUTER_FILTER_LLM_ENABLED", "true");
    vi.stubEnv("OLLAMA_URL", "http://localhost:11434");
    vi.stubEnv("ROUTER_LLM_CIRCUIT_BREAK_MS", "60000");
  });

  it("opens circuit after 5 consecutive failures and blocks further calls", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("Connection refused"));
    vi.stubGlobal("fetch", fetchMock);

    // Trigger 5 failures to open the breaker
    for (let i = 0; i < 5; i++) {
      await extractStructuredFilter(makeRequest("some query"));
    }

    expect(_filterParserCircuitBreaker.state).toBe("open");
    const callCountBeforeOpen = fetchMock.mock.calls.length;

    // Further calls should be blocked (no fetch)
    const result = await extractStructuredFilter(makeRequest("another query"));
    expect(result).toBeNull();
    expect(fetchMock.mock.calls.length).toBe(callCountBeforeOpen);
  });

  it("resets circuit breaker on no_filter response (empty conditions) — prevents failure accumulation", async () => {
    // Trigger 3 failures
    const failingFetch = vi.fn().mockRejectedValue(new Error("fail"));
    vi.stubGlobal("fetch", failingFetch);
    for (let i = 0; i < 3; i++) {
      await extractStructuredFilter(makeRequest("query"));
    }
    expect(_filterParserCircuitBreaker.failures).toBe(3);

    // A clean no-filter response should reset the failure count
    const noFilterFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ response: '{"conditions":[],"combine":"and"}' }),
    } as unknown as Response);
    vi.stubGlobal("fetch", noFilterFetch);

    await extractStructuredFilter(makeRequest("how does auth work"));
    expect(_filterParserCircuitBreaker.failures).toBe(0);
    expect(_filterParserCircuitBreaker.state).toBe("closed");
  });

  it("resets circuit breaker on success", async () => {
    // Open the breaker first
    const failingFetch = vi.fn().mockRejectedValue(new Error("fail"));
    vi.stubGlobal("fetch", failingFetch);
    for (let i = 0; i < 5; i++) {
      await extractStructuredFilter(makeRequest("query"));
    }
    expect(_filterParserCircuitBreaker.state).toBe("open");

    // Simulate half-open by resetting the timer
    _filterParserCircuitBreaker.state = "half-open";

    // Successful response resets
    const successFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        response: '{"conditions":[{"field":"lang","op":"eq","value":"ts"}],"combine":"and"}',
      }),
    } as unknown as Response);
    vi.stubGlobal("fetch", successFetch);

    await extractStructuredFilter(makeRequest("typescript files"));
    expect(_filterParserCircuitBreaker.state).toBe("closed");
    expect(_filterParserCircuitBreaker.failures).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Integration: query pipeline uses inferred filter
// ---------------------------------------------------------------------------

describe("extractStructuredFilter — in operator", () => {
  beforeEach(() => {
    vi.stubEnv("ROUTER_FILTER_LLM_ENABLED", "true");
    vi.stubEnv("OLLAMA_URL", "http://localhost:11434");
  });

  it("handles in operator with values array", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        response: '{"conditions":[{"field":"lang","op":"in","values":["ts","js"]}],"combine":"and"}',
      }),
    } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    const result = await extractStructuredFilter(makeRequest("typescript or javascript files"));
    expect(result).not.toBeNull();
    expect(result!.conditions[0].op).toBe("in");
    expect(result!.conditions[0].values).toEqual(["ts", "js"]);
  });
});
