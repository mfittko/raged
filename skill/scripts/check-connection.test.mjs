import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkConnection } from "./check-connection.mjs";

describe("checkConnection", () => {
  it("returns ok when rag-stack health endpoint responds 200", async () => {
    const mockFetch = async (url) => {
      assert.match(url, /\/healthz$/);
      return { ok: true, json: async () => ({ ok: true }) };
    };

    const result = await checkConnection("http://localhost:8080", mockFetch);

    assert.deepStrictEqual(result, { ok: true, url: "http://localhost:8080" });
  });

  it("returns error when health endpoint returns non-200", async () => {
    const mockFetch = async () => ({ ok: false, status: 503 });

    const result = await checkConnection("http://localhost:8080", mockFetch);

    assert.equal(result.ok, false);
    assert.match(result.error, /503/);
  });

  it("returns error when fetch throws (network unreachable)", async () => {
    const mockFetch = async () => {
      throw new Error("ECONNREFUSED");
    };

    const result = await checkConnection("http://localhost:9999", mockFetch);

    assert.equal(result.ok, false);
    assert.match(result.error, /ECONNREFUSED/);
  });

  it("returns error when health body has ok:false", async () => {
    const mockFetch = async () => ({
      ok: true,
      json: async () => ({ ok: false }),
    });

    const result = await checkConnection("http://localhost:8080", mockFetch);

    assert.equal(result.ok, false);
    assert.match(result.error, /ok.*false/i);
  });

  it("strips trailing slash from URL", async () => {
    let calledUrl = "";
    const mockFetch = async (url) => {
      calledUrl = url;
      return { ok: true, json: async () => ({ ok: true }) };
    };

    await checkConnection("http://localhost:8080/", mockFetch);

    assert.equal(calledUrl, "http://localhost:8080/healthz");
  });
});
