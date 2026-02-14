import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  isGraphEnabled,
  expandEntities,
  getEntity,
  getDocumentsByEntityMention,
} from "./graph-client.js";

describe("graph-client", () => {
  const ORIG_NEO4J_URL = process.env.NEO4J_URL;
  const ORIG_NEO4J_USER = process.env.NEO4J_USER;
  const ORIG_NEO4J_PASSWORD = process.env.NEO4J_PASSWORD;

  beforeEach(() => {
    delete process.env.NEO4J_URL;
    delete process.env.NEO4J_USER;
    delete process.env.NEO4J_PASSWORD;
  });

  afterEach(() => {
    if (ORIG_NEO4J_URL !== undefined) {
      process.env.NEO4J_URL = ORIG_NEO4J_URL;
    }
    if (ORIG_NEO4J_USER !== undefined) {
      process.env.NEO4J_USER = ORIG_NEO4J_USER;
    }
    if (ORIG_NEO4J_PASSWORD !== undefined) {
      process.env.NEO4J_PASSWORD = ORIG_NEO4J_PASSWORD;
    }
  });

  describe("isGraphEnabled", () => {
    it("returns false when Neo4j is not configured", () => {
      expect(isGraphEnabled()).toBe(false);
    });

    it("returns false when only URL is set", () => {
      process.env.NEO4J_URL = "bolt://localhost:7687";
      expect(isGraphEnabled()).toBe(false);
    });

    it("returns false when only password is set", () => {
      process.env.NEO4J_PASSWORD = "secret";
      expect(isGraphEnabled()).toBe(false);
    });

    it("returns true when all credentials are set", () => {
      process.env.NEO4J_URL = "bolt://localhost:7687";
      process.env.NEO4J_USER = "neo4j";
      process.env.NEO4J_PASSWORD = "secret";
      expect(isGraphEnabled()).toBe(true);
    });
  });

  describe("expandEntities (without Neo4j)", () => {
    it("returns empty array when graph is not enabled", async () => {
      const result = await expandEntities(["AuthService", "JWT"]);
      expect(result).toEqual([]);
    });

    it("returns empty array when entity list is empty", async () => {
      process.env.NEO4J_URL = "bolt://localhost:7687";
      process.env.NEO4J_USER = "neo4j";
      process.env.NEO4J_PASSWORD = "secret";
      
      const result = await expandEntities([]);
      expect(result).toEqual([]);
    });
  });

  describe("getEntity (without Neo4j)", () => {
    it("returns null when graph is not enabled", async () => {
      const result = await getEntity("AuthService");
      expect(result).toBeNull();
    });
  });

  describe("getDocumentsByEntityMention (without Neo4j)", () => {
    it("returns empty array when graph is not enabled", async () => {
      const result = await getDocumentsByEntityMention("AuthService");
      expect(result).toEqual([]);
    });
  });
});
