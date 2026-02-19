import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { checkUrl } from "./url-check.js";

describe("url-check", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("should mark unreachable URLs as not meaningful", async () => {
    globalThis.fetch = async () => {
      throw new Error("network error");
    };

    const result = await checkUrl("https://unreachable.example.com", "test-key");
    expect(result.reachable).toBe(false);
    expect(result.meaningful).toBe(false);
    expect(result.reason).toContain("network error");
  });

  it("should mark non-OK HTTP responses as not meaningful", async () => {
    globalThis.fetch = async (url: string | URL | Request) => {
      const urlStr = url instanceof Request ? url.url : url.toString();
      if (urlStr.includes("api.openai.com")) {
        throw new Error("should not call OpenAI for unreachable URLs");
      }
      return new Response("Not Found", { status: 404 });
    };

    const result = await checkUrl("https://example.com/missing", "test-key");
    expect(result.reachable).toBe(false);
    expect(result.meaningful).toBe(false);
    expect(result.reason).toBe("HTTP 404");
  });

  it("should skip binary content types", async () => {
    globalThis.fetch = async (url: string | URL | Request) => {
      const urlStr = url instanceof Request ? url.url : url.toString();
      if (urlStr.includes("api.openai.com")) {
        throw new Error("should not call OpenAI for binary content");
      }
      return new Response("binary data", {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    };

    const result = await checkUrl("https://example.com/image.png", "test-key");
    expect(result.reachable).toBe(false);
    expect(result.meaningful).toBe(false);
    expect(result.reason).toContain("binary content-type");
  });

  it("should mark pages with almost no text as not meaningful without calling OpenAI", async () => {
    globalThis.fetch = async (url: string | URL | Request) => {
      const urlStr = url instanceof Request ? url.url : url.toString();
      if (urlStr.includes("api.openai.com")) {
        throw new Error("should not call OpenAI for near-empty pages");
      }
      return new Response("<html><body>  </body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    };

    const result = await checkUrl("https://example.com/empty", "test-key");
    expect(result.reachable).toBe(true);
    expect(result.meaningful).toBe(false);
    expect(result.reason).toContain("almost no text");
  });

  it("should call OpenAI and return meaningful=true for good content", async () => {
    let openAiCalled = false;

    globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url instanceof Request ? url.url : url.toString();

      if (urlStr.includes("api.openai.com")) {
        openAiCalled = true;
        const body = JSON.parse(init?.body as string);
        expect(body.model).toBe("gpt-4o-mini");
        expect(body.messages[0].content).toContain("meaningful");

        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    meaningful: true,
                    reason: "Article with substantive content about testing",
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      // Page content response
      return new Response(
        "<html><body><h1>Testing Guide</h1><p>This is a comprehensive guide to testing your applications with vitest. It covers unit tests, integration tests, and end-to-end testing strategies.</p></body></html>",
        { status: 200, headers: { "content-type": "text/html" } },
      );
    };

    const result = await checkUrl("https://example.com/guide", "test-key");
    expect(openAiCalled).toBe(true);
    expect(result.reachable).toBe(true);
    expect(result.meaningful).toBe(true);
    expect(result.reason).toContain("substantive");
  });

  it("should call OpenAI and return meaningful=false for login walls", async () => {
    globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url instanceof Request ? url.url : url.toString();

      if (urlStr.includes("api.openai.com")) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    meaningful: false,
                    reason: "Login page with no substantive content",
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      return new Response(
        "<html><body><h1>Login to Your Account</h1><p>Please enter your credentials below to access the dashboard.</p><form><label>Email Address</label><input name='email'><label>Password</label><input name='password'><button>Sign In</button></form><p>Forgot your password? Click here to reset.</p></body></html>",
        { status: 200, headers: { "content-type": "text/html" } },
      );
    };

    const result = await checkUrl("https://example.com/login", "test-key");
    expect(result.meaningful).toBe(false);
    expect(result.reason).toContain("Login");
  });

  it("should default to meaningful when OpenAI response is unparseable", async () => {
    globalThis.fetch = async (url: string | URL | Request) => {
      const urlStr = url instanceof Request ? url.url : url.toString();

      if (urlStr.includes("api.openai.com")) {
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "not valid json" } }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      return new Response(
        "<html><body><p>Some real content here that is definitely more than thirty characters long for testing</p></body></html>",
        { status: 200, headers: { "content-type": "text/html" } },
      );
    };

    const result = await checkUrl("https://example.com/page", "test-key");
    expect(result.meaningful).toBe(true);
    expect(result.reason).toContain("defaulting to pass");
  });

  it("should use custom base URL and model", async () => {
    let capturedUrl = "";
    let capturedModel = "";

    globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url instanceof Request ? url.url : url.toString();

      if (urlStr.includes("custom-api.example.com")) {
        capturedUrl = urlStr;
        const body = JSON.parse(init?.body as string);
        capturedModel = body.model;

        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({ meaningful: true, reason: "good" }),
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      return new Response("<html><body><p>Good content that is long enough to pass the minimum length check</p></body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    };

    await checkUrl(
      "https://example.com",
      "test-key",
      "https://custom-api.example.com/v1",
      "gpt-4o",
    );

    expect(capturedUrl).toBe("https://custom-api.example.com/v1/chat/completions");
    expect(capturedModel).toBe("gpt-4o");
  });
});
