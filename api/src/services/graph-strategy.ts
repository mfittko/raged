import type { GraphBackend, GraphResult, TraversalParams } from "./graph-backend.js";
import type { QueryResultItem } from "./query.js";

const DEFAULT_MAX_DEPTH = 2;
const DEFAULT_MAX_ENTITIES = 50;
const TRAVERSAL_TIME_LIMIT_MS = 5000;
const MAX_SEED_NAMES = 50;

export interface GraphParams {
  maxDepth?: number;
  maxEntities?: number;
  relationshipTypes?: string[];
  includeDocuments?: boolean;
  seedEntities?: string[];
}

function extractSeedNamesFromResults(results: QueryResultItem[]): string[] {
  const seen = new Set<string>();
  const names: string[] = [];

  for (const item of results) {
    const tier2Meta = item.payload?.tier2Meta as Record<string, unknown> | undefined;
    const tier3Meta = item.payload?.tier3Meta as Record<string, unknown> | undefined;

    if (Array.isArray(tier2Meta?.entities)) {
      for (const entity of tier2Meta.entities as Array<{ text: string }>) {
        const lower = entity.text?.toLowerCase();
        if (lower && !seen.has(lower)) {
          seen.add(lower);
          names.push(entity.text);
        }
      }
    }

    if (Array.isArray(tier3Meta?.entities)) {
      for (const entity of tier3Meta.entities as Array<{ name: string }>) {
        const lower = entity.name?.toLowerCase();
        if (lower && !seen.has(lower)) {
          seen.add(lower);
          names.push(entity.name);
        }
      }
    }
  }

  return names.slice(0, MAX_SEED_NAMES);
}

export async function executeGraphStrategy(
  params: GraphParams,
  results: QueryResultItem[],
  backend: GraphBackend,
): Promise<GraphResult | undefined> {
  const warnings: string[] = [];

  // Determine seed names
  let seedNames: string[];
  let seedSource: "results" | "explicit";

  if (params.seedEntities && params.seedEntities.length > 0) {
    seedNames = params.seedEntities.slice(0, MAX_SEED_NAMES);
    seedSource = "explicit";
  } else {
    // D10: empty seedEntities → fall back to extraction
    seedNames = extractSeedNamesFromResults(results);
    seedSource = "results";
  }

  // D1: no entities in result metadata
  if (seedNames.length === 0) {
    warnings.push("No entities found in result metadata to seed the graph");
    return {
      entities: [],
      relationships: [],
      paths: [],
      documents: [],
      meta: {
        seedEntities: [],
        seedSource,
        maxDepthUsed: params.maxDepth ?? DEFAULT_MAX_DEPTH,
        entityCount: 0,
        entityCap: params.maxEntities ?? DEFAULT_MAX_ENTITIES,
        capped: false,
        timeLimitMs: TRAVERSAL_TIME_LIMIT_MS,
        timedOut: false,
        warnings,
      },
    };
  }

  // Resolve seed names to entities with IDs
  let resolvedEntities;
  try {
    resolvedEntities = await backend.resolveEntities(seedNames);
  } catch (err) {
    // D9: DB error in resolution → omit graph key, log error
    console.error("[graph-strategy] resolveEntities error:", err);
    return undefined;
  }

  // Collect warnings for unresolved names using requestedName to handle prefix-resolved entities
  const resolvedRequestedLower = new Set(resolvedEntities.map((e) => e.requestedName.toLowerCase()));
  for (const name of seedNames) {
    if (!resolvedRequestedLower.has(name.toLowerCase())) {
      warnings.push(`Entity not found: "${name}"`);
    }
  }

  // D2: no seeds resolve
  if (resolvedEntities.length === 0) {
    warnings.push("None of the seed entities could be resolved");
    return {
      entities: [],
      relationships: [],
      paths: [],
      documents: [],
      meta: {
        seedEntities: seedNames,
        seedSource,
        maxDepthUsed: params.maxDepth ?? DEFAULT_MAX_DEPTH,
        entityCount: 0,
        entityCap: params.maxEntities ?? DEFAULT_MAX_ENTITIES,
        capped: false,
        timeLimitMs: TRAVERSAL_TIME_LIMIT_MS,
        timedOut: false,
        warnings,
      },
    };
  }

  const seedIds = resolvedEntities.map((e) => e.id);
  const traversalParams: TraversalParams = {
    maxDepth: params.maxDepth ?? DEFAULT_MAX_DEPTH,
    maxEntities: params.maxEntities ?? DEFAULT_MAX_ENTITIES,
    relationshipTypes: params.relationshipTypes ?? [],
    includeDocuments: params.includeDocuments ?? false,
    timeLimitMs: TRAVERSAL_TIME_LIMIT_MS,
  };

  // D3: partial resolution — traverse with resolved subset; warnings already added above
  let traversalResult;
  try {
    traversalResult = await backend.traverse(seedIds, traversalParams);
  } catch (err) {
    // D8: DB error in traversal → omit graph key, log error
    console.error("[graph-strategy] traverse error:", err);
    return undefined;
  }

  // Propagate resolution warnings into traversal meta
  const allWarnings = [...warnings, ...traversalResult.meta.warnings];

  // Optionally fetch documents (D7: no mentions → empty documents[], no warning)
  let documents = traversalResult.documents;
  if (params.includeDocuments) {
    try {
      const entityIds = traversalResult.entities.map((e) => e.id);
      documents = await backend.getEntityDocuments(entityIds, 100);
    } catch (err) {
      console.error("[graph-strategy] getEntityDocuments error:", err);
      // D7: treat as empty documents on error
      documents = [];
    }
  }

  return {
    entities: traversalResult.entities.map((e) => ({
      name: e.name,
      type: e.type,
      depth: e.depth,
      isSeed: e.isSeed,
      mentionCount: e.mentionCount,
    })),
    relationships: traversalResult.relationships,
    paths: traversalResult.paths,
    documents,
    meta: {
      ...traversalResult.meta,
      seedEntities: resolvedEntities.map((e) => e.name),
      seedSource,
      warnings: allWarnings,
    },
  };
}
