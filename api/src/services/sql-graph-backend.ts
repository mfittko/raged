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
  entities: Array<TraversalEntity & { pathNames: string[]; pathRelTypes: string[] }>,
  relationships: Edge[],
): EntityPath[] {
  if (entities.length === 0) return [];

  // Build a directional edge lookup (fallback for edges not covered by CTE path): "A:B" -> string[]
  const edgeLookup = new Map<string, string[]>();
  for (const rel of relationships) {
    const fwd = `${rel.source}:${rel.target}`;
    const bwd = `${rel.target}:${rel.source}`;
    if (!edgeLookup.has(fwd)) edgeLookup.set(fwd, []);
    edgeLookup.get(fwd)!.push(rel.type);
    if (!edgeLookup.has(bwd)) edgeLookup.set(bwd, []);
    edgeLookup.get(bwd)!.push(rel.type);
  }

  // Build a set of all strict path prefixes so leaf detection is O(n·L) not O(n²)
  const isPrefixOf = new Set<string>();
  for (const e of entities) {
    for (let j = 1; j < e.pathNames.length; j++) {
      isPrefixOf.add(e.pathNames.slice(0, j).join("\x00"));
    }
  }
  // Leaf: its path key does not appear as a strict prefix of any other path
  const leafEntities = entities.filter((e) => !isPrefixOf.has(e.pathNames.join("\x00")));

  // Deduplicate leaf paths by value equality
  const seen = new Set<string>();
  const uniqueLeafEntities = leafEntities.filter((e) => {
    const key = e.pathNames.join("\x00");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return uniqueLeafEntities.map((e) => {
    const pathNames = e.pathNames;
    // pathRelTypes from CTE has length = pathNames.length - 1 (one per edge in the path)
    const edgeTypes: string[] = [];
    for (let i = 0; i < pathNames.length - 1; i++) {
      if (i < e.pathRelTypes.length) {
        edgeTypes.push(e.pathRelTypes[i]);
      } else {
        // Fallback to edge lookup (should not happen in practice)
        const s = pathNames[i];
        const t = pathNames[i + 1];
        const types = edgeLookup.get(`${s}:${t}`) ?? edgeLookup.get(`${t}:${s}`);
        edgeTypes.push(types?.[0] ?? "unknown");
      }
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

    // Deduplicate by LOWER, keeping first occurrence as the canonical requested name
    const seen = new Set<string>();
    const uniqueNames: string[] = [];
    for (const name of names) {
      const lower = name.toLowerCase();
      if (!seen.has(lower)) {
        seen.add(lower);
        uniqueNames.push(name);
      }
    }

    // Map from lowercase → original requested name (for requestedName tracking)
    const lowerToRequested = new Map<string, string>();
    for (const name of uniqueNames) {
      lowerToRequested.set(name.toLowerCase(), name);
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
       WHERE LOWER(name) = ANY($1::text[])
       ORDER BY LOWER(name), name, id`,
      [normalised],
    );

    const resolved = new Map<string, ResolvedEntity>();
    const exactByLower = new Map<string, typeof exactResult.rows>();
    for (const row of exactResult.rows) {
      const lower = row.name.toLowerCase();
      const group = exactByLower.get(lower);
      if (group) {
        group.push(row);
      } else {
        exactByLower.set(lower, [row]);
      }
    }
    for (const [lower, rows] of exactByLower) {
      const requestedName = lowerToRequested.get(lower) ?? lower;
      const selectedRow =
        rows.find((row) => row.name === requestedName) ??
        (rows.length === 1 ? rows[0] : undefined);
      if (!selectedRow) continue;
      resolved.set(lower, {
        id: selectedRow.id,
        name: selectedRow.name,
        type: selectedRow.type ?? "unknown",
        description: selectedRow.description ?? undefined,
        mentionCount: selectedRow.mention_count,
        requestedName,
      });
    }

    // Prefix fallback for unresolved names (only when ≤ 10 unresolved)
    const unresolved = uniqueNames.filter((n) => !resolved.has(n.toLowerCase()));
    if (unresolved.length > 0 && unresolved.length <= 10) {
      const unresolvedLower = unresolved.map((n) => n.toLowerCase());
      // Single batched query: lateral join returns at most 2 rows per prefix so we can
      // distinguish 0 / 1 / 2+ matches per requested name without N+1 round trips.
      const prefixResult = await this.pool.query<{
        matched_prefix: string;
        id: string;
        name: string;
        type: string;
        description: string | null;
        mention_count: number;
      }>(
        `SELECT p.prefix AS matched_prefix, e.id::text AS id, e.name, e.type, e.description, e.mention_count
         FROM unnest($1::text[]) AS p(prefix)
         JOIN LATERAL (
           SELECT id, name, type, description, mention_count
           FROM entities
           WHERE LOWER(name) LIKE p.prefix || '%'
           ORDER BY name, id
           LIMIT 2
         ) e ON true
         ORDER BY p.prefix, e.name, e.id`,
        [unresolvedLower],
      );

      // Group candidates by matched prefix; accept only unambiguous (exactly 1) matches
      const byPrefix = new Map<string, typeof prefixResult.rows>();
      for (const row of prefixResult.rows) {
        const group = byPrefix.get(row.matched_prefix);
        if (group) {
          group.push(row);
        } else {
          byPrefix.set(row.matched_prefix, [row]);
        }
      }

      for (const [prefix, rows] of byPrefix) {
        if (rows.length === 1) {
          const row = rows[0];
          resolved.set(prefix, {
            id: row.id,
            name: row.name,
            type: row.type ?? "unknown",
            description: row.description ?? undefined,
            mentionCount: row.mention_count,
            requestedName: lowerToRequested.get(prefix) ?? prefix,
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
               ARRAY[e.name::text] AS path_names,
               ARRAY[]::text[] AS path_rel_types
        FROM entities e
        WHERE e.id = ANY($1::uuid[])

        UNION ALL

        SELECT e.id, e.name, e.type, e.mention_count,
               eg.depth + 1,
               eg.path || e.id,
               eg.path_names || e.name::text,
               eg.path_rel_types || er.relationship_type::text
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
        SELECT DISTINCT ON (id) id::text, name, type, mention_count, depth, path_names, path_rel_types
        FROM entity_graph
        ORDER BY id, depth ASC, path_names ASC, path_rel_types ASC
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
      path_rel_types: string[];
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
      const statementTimeoutMs =
        typeof params.timeLimitMs === "number" && Number.isFinite(params.timeLimitMs)
          ? Math.max(0, Math.floor(params.timeLimitMs))
          : 0;
      await client.query(`SET LOCAL statement_timeout = ${statementTimeoutMs}`);

      const entityResult = await client.query<TraversalRow>(traversalSQL, queryParams);
      entityRows = entityResult.rows;

      const capped = entityRows.length >= params.maxEntities;

      const entityNames = entityRows.map((r) => r.name);

      // Fetch relationships between discovered entities, applying the same type filter
      const relQuery =
        params.relationshipTypes.length > 0
          ? {
              sql: `SELECT es.name AS source_name, et.name AS target_name, er.relationship_type
                    FROM entity_relationships er
                    JOIN entities es ON er.source_id = es.id
                    JOIN entities et ON er.target_id = et.id
                    WHERE es.name = ANY($1::text[])
                      AND et.name = ANY($1::text[])
                      AND er.relationship_type = ANY($2::text[])`,
              params: [entityNames, params.relationshipTypes] as unknown[],
            }
          : {
              sql: `SELECT es.name AS source_name, et.name AS target_name, er.relationship_type
                    FROM entity_relationships er
                    JOIN entities es ON er.source_id = es.id
                    JOIN entities et ON er.target_id = et.id
                    WHERE es.name = ANY($1::text[])
                      AND et.name = ANY($1::text[])`,
              params: [entityNames] as unknown[],
            };
      const relResult = await client.query<RelationshipRow>(relQuery.sql, relQuery.params);
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
        pathRelTypes: Array.isArray(r.path_rel_types) ? r.path_rel_types : [],
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
       ORDER BY
         CASE WHEN name = $1 THEN 0 ELSE 1 END,
         mention_count DESC,
         id ASC
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
      requestedName: name,
    };
  }

  async getEntityRelationships(entityId: string, limit: number): Promise<EntityRelationship[]> {
    const result = await this.pool.query<{
      entity_name: string;
      relationship: string;
      direction: string;
      description: string | null;
    }>(
      `SELECT entity_name, relationship, direction, description
       FROM (
         SELECT et.name AS entity_name,
                er.relationship_type AS relationship,
                'outbound' AS direction,
                er.description,
                er.created_at
         FROM entity_relationships er
         JOIN entities et ON er.target_id = et.id
         WHERE er.source_id = $1::uuid
         UNION ALL
         SELECT es.name AS entity_name,
                er.relationship_type AS relationship,
                'inbound' AS direction,
                er.description,
                er.created_at
         FROM entity_relationships er
         JOIN entities es ON er.source_id = es.id
         WHERE er.target_id = $1::uuid
       ) AS all_relationships
       ORDER BY created_at DESC
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
