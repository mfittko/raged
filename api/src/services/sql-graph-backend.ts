import type pg from "pg";
import type {
  GraphBackend,
  ResolvedEntity,
  TraversalResult,
  TraversalParams,
  TraversalEntity,
  Edge,
  EntityDocument,
  EntityRelationship,
  EntityPath,
} from "./graph-backend.js";

type Pool = pg.Pool;

function constructPaths(
  entities: Array<TraversalEntity & { pathNames: string[] }>,
  relationships: Edge[],
): EntityPath[] {
  if (entities.length === 0) return [];

  // Build bidirectional edge lookup: "A:B" -> type
  const edgeLookup = new Map<string, string>();
  for (const rel of relationships) {
    edgeLookup.set(`${rel.source}:${rel.target}`, rel.type);
    edgeLookup.set(`${rel.target}:${rel.source}`, rel.type);
  }

  const allPaths = entities.map((e) => e.pathNames);

  // Leaf: no other path starts with this path as a strict prefix
  const leafPaths = allPaths.filter(
    (pathA) =>
      !allPaths.some(
        (pathB) =>
          pathB.length > pathA.length &&
          pathB.slice(0, pathA.length).every((name, i) => name === pathA[i]),
      ),
  );

  // Deduplicate leaf paths by value equality
  const seen = new Set<string>();
  const uniqueLeafPaths = leafPaths.filter((path) => {
    const key = path.join("\x00");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return uniqueLeafPaths.map((pathNames) => {
    const edgeTypes: string[] = [];
    for (let i = 0; i < pathNames.length - 1; i++) {
      const s = pathNames[i];
      const t = pathNames[i + 1];
      edgeTypes.push(
        edgeLookup.get(`${s}:${t}`) ??
          edgeLookup.get(`${t}:${s}`) ??
          "unknown",
      );
    }
    return {
      entities: pathNames,
      relationships: edgeTypes,
      depth: pathNames.length - 1,
    };
  });
}

export class SqlGraphBackend implements GraphBackend {
  constructor(private readonly pool: Pool) {}

  async resolveEntities(names: string[]): Promise<ResolvedEntity[]> {
    if (names.length === 0) return [];

    // Deduplicate by LOWER
    const seen = new Set<string>();
    const uniqueNames: string[] = [];
    for (const name of names) {
      const lower = name.toLowerCase();
      if (!seen.has(lower)) {
        seen.add(lower);
        uniqueNames.push(name);
      }
    }

    const normalised = uniqueNames.map((n) => n.toLowerCase());

    // Exact match via idx_entities_name_lower
    const exactResult = await this.pool.query<{
      id: string;
      name: string;
      type: string;
      description: string | null;
      mention_count: number;
    }>(
      `SELECT id::text, name, type, description, mention_count
       FROM entities
       WHERE LOWER(name) = ANY($1::text[])`,
      [normalised],
    );

    const resolved = new Map<string, ResolvedEntity>();
    for (const row of exactResult.rows) {
      resolved.set(row.name.toLowerCase(), {
        id: row.id,
        name: row.name,
        type: row.type ?? "unknown",
        description: row.description ?? undefined,
        mentionCount: row.mention_count,
      });
    }

    // Prefix fallback for unresolved names (only when ≤ 10 unresolved)
    const unresolved = uniqueNames.filter((n) => !resolved.has(n.toLowerCase()));
    if (unresolved.length > 0 && unresolved.length <= 10) {
      for (const name of unresolved) {
        const prefixResult = await this.pool.query<{
          id: string;
          name: string;
          type: string;
          description: string | null;
          mention_count: number;
        }>(
          `SELECT id::text, name, type, description, mention_count
           FROM entities
           WHERE LOWER(name) LIKE $1 || '%'`,
          [name.toLowerCase()],
        );
        // Accept only unambiguous (exactly 1) prefix match
        if (prefixResult.rows.length === 1) {
          const row = prefixResult.rows[0];
          resolved.set(name.toLowerCase(), {
            id: row.id,
            name: row.name,
            type: row.type ?? "unknown",
            description: row.description ?? undefined,
            mentionCount: row.mention_count,
          });
        }
      }
    }

    return Array.from(resolved.values());
  }

  async traverse(seedIds: string[], params: TraversalParams): Promise<TraversalResult> {
    if (seedIds.length === 0) {
      return {
        entities: [],
        relationships: [],
        paths: [],
        documents: [],
        meta: {
          seedEntities: [],
          seedSource: "results",
          maxDepthUsed: params.maxDepth,
          entityCount: 0,
          entityCap: params.maxEntities,
          capped: false,
          timeLimitMs: params.timeLimitMs,
          timedOut: false,
          warnings: [],
        },
      };
    }

    const relTypeClause =
      params.relationshipTypes.length > 0
        ? `AND er.relationship_type = ANY($3::text[])`
        : "";

    // maxDepth param index: 2, relTypes param index: 3 (if used), maxEntities: 3 or 4
    const maxEntitiesIdx = params.relationshipTypes.length > 0 ? 4 : 3;

    const traversalSQL = `
      WITH RECURSIVE entity_graph AS (
        SELECT e.id, e.name, e.type, e.mention_count,
               0 AS depth,
               ARRAY[e.id] AS path,
               ARRAY[e.name::text] AS path_names
        FROM entities e
        WHERE e.id = ANY($1::uuid[])

        UNION ALL

        SELECT e.id, e.name, e.type, e.mention_count,
               eg.depth + 1,
               eg.path || e.id,
               eg.path_names || e.name::text
        FROM entity_graph eg
        JOIN entity_relationships er
          ON er.source_id = eg.id OR er.target_id = eg.id
        JOIN entities e
          ON e.id = CASE
            WHEN er.source_id = eg.id THEN er.target_id
            ELSE er.source_id
          END
        WHERE eg.depth < $2
          AND e.id <> ALL(eg.path)
          ${relTypeClause}
      )
      SELECT * FROM (
        SELECT DISTINCT ON (id) id::text, name, type, mention_count, depth, path_names
        FROM entity_graph
        ORDER BY id, depth ASC
      ) deduped
      ORDER BY depth ASC
      LIMIT $${maxEntitiesIdx}
    `;

    const queryParams: unknown[] =
      params.relationshipTypes.length > 0
        ? [seedIds, params.maxDepth, params.relationshipTypes, params.maxEntities]
        : [seedIds, params.maxDepth, params.maxEntities];

    let timedOut = false;

    type TraversalRow = {
      id: string;
      name: string;
      type: string;
      mention_count: number;
      depth: number;
      path_names: string[];
    };
    type RelationshipRow = {
      source_name: string;
      target_name: string;
      relationship_type: string;
    };

    let entityRows: TraversalRow[] = [];
    let relRows: RelationshipRow[] = [];

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL statement_timeout = ${params.timeLimitMs}`);

      const entityResult = await client.query<TraversalRow>(traversalSQL, queryParams);
      entityRows = entityResult.rows;

      const capped = entityRows.length >= params.maxEntities;

      const entityNames = entityRows.map((r) => r.name);

      // Fetch relationships between discovered entities
      const relResult = await client.query<RelationshipRow>(
        `SELECT es.name AS source_name, et.name AS target_name, er.relationship_type
         FROM entity_relationships er
         JOIN entities es ON er.source_id = es.id
         JOIN entities et ON er.target_id = et.id
         WHERE es.name = ANY($1::text[])
           AND et.name = ANY($1::text[])`,
        [entityNames],
      );
      relRows = relResult.rows;

      await client.query("COMMIT");

      const seedIdSet = new Set(seedIds.map((id) => id?.toLowerCase()));
      const traversalEntities = entityRows.map((r) => ({
        id: r.id,
        name: r.name,
        type: r.type ?? "unknown",
        depth: r.depth ?? 0,
        isSeed: seedIdSet.has(r.id?.toLowerCase()),
        mentionCount: r.mention_count ?? undefined,
        pathNames: Array.isArray(r.path_names) ? r.path_names : [r.name],
      }));

      const relationships: Edge[] = relRows.map((r) => ({
        source: r.source_name,
        target: r.target_name,
        type: r.relationship_type,
      }));

      const paths = constructPaths(traversalEntities, relationships);

      const seedNames = traversalEntities
        .filter((e) => e.isSeed)
        .map((e) => e.name);

      return {
        entities: traversalEntities,
        relationships,
        paths,
        documents: [],
        meta: {
          seedEntities: seedNames,
          seedSource: "results",
          maxDepthUsed: params.maxDepth,
          entityCount: traversalEntities.length,
          entityCap: params.maxEntities,
          capped,
          timeLimitMs: params.timeLimitMs,
          timedOut,
          warnings: [],
        },
      };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});

      // Postgres error 57014: statement_timeout exceeded
      if (
        err !== null &&
        typeof err === "object" &&
        (err as { code?: string }).code === "57014"
      ) {
        timedOut = true;

        const seedIdSet = new Set(seedIds.map((id) => id?.toLowerCase()));
        const partial = entityRows.map((r) => ({
          id: r.id,
          name: r.name,
          type: r.type ?? "unknown",
          depth: r.depth ?? 0,
          isSeed: seedIdSet.has(r.id?.toLowerCase()),
          mentionCount: r.mention_count ?? undefined,
        }));
        const partialRels: Edge[] = relRows.map((r) => ({
          source: r.source_name,
          target: r.target_name,
          type: r.relationship_type,
        }));

        return {
          entities: partial,
          relationships: partialRels,
          paths: [],
          documents: [],
          meta: {
            seedEntities: partial.filter((e) => e.isSeed).map((e) => e.name),
            seedSource: "results",
            maxDepthUsed: params.maxDepth,
            entityCount: partial.length,
            entityCap: params.maxEntities,
            capped: false,
            timeLimitMs: params.timeLimitMs,
            timedOut: true,
            warnings: ["Graph traversal timed out; returning partial results"],
          },
        };
      }

      throw err;
    } finally {
      client.release();
    }
  }

  async getEntityDocuments(entityIds: string[], limit: number): Promise<EntityDocument[]> {
    if (entityIds.length === 0) return [];

    const result = await this.pool.query<{
      document_id: string;
      source: string;
      entity_name: string;
      mention_count: number;
    }>(
      `SELECT dem.document_id::text, d.source, e.name AS entity_name, dem.mention_count
       FROM document_entity_mentions dem
       JOIN documents d ON dem.document_id = d.id
       JOIN entities e ON dem.entity_id = e.id
       WHERE dem.entity_id = ANY($1::uuid[])
       LIMIT $2`,
      [entityIds, limit],
    );

    return result.rows.map((r) => ({
      documentId: r.document_id,
      source: r.source,
      entityName: r.entity_name,
      mentionCount: r.mention_count,
    }));
  }

  async getEntity(name: string): Promise<ResolvedEntity | null> {
    const result = await this.pool.query<{
      id: string;
      name: string;
      type: string | null;
      description: string | null;
      mention_count: number;
    }>(
      `SELECT id::text, name, type, description, mention_count
       FROM entities
       WHERE LOWER(name) = LOWER($1)
       LIMIT 1`,
      [name],
    );

    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    return {
      id: row.id,
      name: row.name,
      type: row.type ?? "unknown",
      description: row.description ?? undefined,
      mentionCount: row.mention_count,
    };
  }

  async getEntityRelationships(entityId: string, limit: number): Promise<EntityRelationship[]> {
    const result = await this.pool.query<{
      entity_name: string;
      relationship: string;
      direction: string;
      description: string | null;
    }>(
      `SELECT et.name AS entity_name, er.relationship_type AS relationship,
              'outbound' AS direction, er.description
       FROM entity_relationships er
       JOIN entities et ON er.target_id = et.id
       WHERE er.source_id = $1::uuid
       UNION ALL
       SELECT es.name AS entity_name, er.relationship_type AS relationship,
              'inbound' AS direction, er.description
       FROM entity_relationships er
       JOIN entities es ON er.source_id = es.id
       WHERE er.target_id = $1::uuid
       LIMIT $2`,
      [entityId, limit],
    );

    return result.rows.map((r) => ({
      entityName: r.entity_name,
      relationship: r.relationship,
      direction: r.direction as "outbound" | "inbound",
      description: r.description ?? undefined,
    }));
  }
}
