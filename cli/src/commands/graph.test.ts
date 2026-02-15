import { describe, it, expect, beforeEach } from "vitest";
import { cmdGraph } from "./graph.js";

describe("graph command", () => {
  let fetchMock: typeof globalThis.fetch;
  
  beforeEach(() => {
    fetchMock = globalThis.fetch;
  });

  it("should fetch entity from graph API", async () => {
    const mockEntity = {
      entity: {
        name: "TypeScript",
        type: "Technology",
        description: "A typed superset of JavaScript",
      },
      connections: [
        { entity: "JavaScript", relationship: "extends", direction: "outgoing" },
      ],
      documents: [
        { id: "doc1" },
        { id: "doc2" },
      ],
    };

    globalThis.fetch = async (url: string | URL | Request) => {
      expect(url).toBe("http://localhost:8080/graph/entity/TypeScript");
      return new Response(JSON.stringify(mockEntity), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await cmdGraph({
      entity: "TypeScript",
      api: "http://localhost:8080",
    });

    globalThis.fetch = fetchMock;
  });

  it("should handle entity not found", async () => {
    globalThis.fetch = async () => {
      return new Response("Not Found", { status: 404 });
    };

    await cmdGraph({ entity: "UnknownEntity" });

    globalThis.fetch = fetchMock;
  });

  it("should handle Neo4j not configured error", async () => {
    globalThis.fetch = async () => {
      return new Response("Service Unavailable", { status: 503 });
    };

    await expect(cmdGraph({ entity: "Test" })).rejects.toThrow("Graph functionality is not enabled");

    globalThis.fetch = fetchMock;
  });

  it("should exit with error when entity is missing", async () => {
    const exitSpy = process.exit;
    let exitCode = 0;
    process.exit = ((code: number) => {
      exitCode = code;
      throw new Error("exit");
    }) as never;

    try {
      await cmdGraph({});
    } catch (e) {
      // Expected to throw
    }

    expect(exitCode).toBe(2);
    process.exit = exitSpy;
  });

  it("should handle other API errors", async () => {
    globalThis.fetch = async () => {
      return new Response("Internal Server Error", { status: 500 });
    };

    await expect(cmdGraph({ entity: "Test" })).rejects.toThrow("Failed to get entity: 500");

    globalThis.fetch = fetchMock;
  });
});
