import neo4j from "neo4j-driver";

let driver: ReturnType<typeof neo4j.driver> | null = null;

function getDriver() {
  const NEO4J_URL = process.env.NEO4J_URL || "";
  const NEO4J_USER = process.env.NEO4J_USER || "neo4j";
  const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD || "";

  if (!NEO4J_URL || !NEO4J_USER || !NEO4J_PASSWORD) {
    return null;
  }
  if (!driver) {
    driver = neo4j.driver(
      NEO4J_URL,
      neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD),
    );
  }
  return driver;
}

export function isGraphEnabled(): boolean {
  const NEO4J_URL = process.env.NEO4J_URL || "";
  const NEO4J_USER = process.env.NEO4J_USER || "neo4j";
  const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD || "";
  return Boolean(NEO4J_URL && NEO4J_USER && NEO4J_PASSWORD);
}

export interface Entity {
  name: string;
  type: string;
  description?: string;
}

export interface EntityConnection {
  entity: string;
  relationship: string;
  direction: "incoming" | "outgoing";
}

export interface EntityDetails {
  entity: {
    name: string;
    type: string;
    description?: string;
    firstSeen?: string;
    lastSeen?: string;
    mentionCount?: number;
  };
  connections: EntityConnection[];
}

const DEFAULT_DEPTH = 2;
const MAX_DEPTH = 10;

export async function expandEntities(
  entityNames: string[],
  depth = DEFAULT_DEPTH,
): Promise<Entity[]> {
  // Short-circuit on empty input before initializing driver
  if (entityNames.length === 0) return [];

  const d = getDriver();
  if (!d) return [];

  // Sanitize depth: ensure it is a positive integer within a reasonable upper bound.
  const normalizedDepth = Number.isInteger(depth) ? depth : DEFAULT_DEPTH;
  const safeDepth = Math.min(Math.max(normalizedDepth, 1), MAX_DEPTH);

  const session = d.session();
  try {
    // Required index: Entity.name (see task #8 for index creation)
    const query = `
      MATCH (e:Entity)
      WHERE e.name IN $entityNames
      MATCH path = (e)-[:RELATES_TO*1..${safeDepth}]-(neighbor:Entity)
      RETURN DISTINCT neighbor.name AS name, neighbor.type AS type, neighbor.description AS description
      LIMIT 200
      `;
    const result = await session.run(query, { entityNames });
    return result.records.map((record) => ({
      name: record.get("name") as string,
      type: record.get("type") as string,
      description: record.get("description") as string | undefined,
    }));
  } finally {
    await session.close();
  }
}

export async function getEntity(name: string): Promise<EntityDetails | null> {
  const d = getDriver();
  if (!d) return null;

  const session = d.session();
  try {
    // Required index: Entity.name (see task #8 for index creation)
    const result = await session.run(
      `
      MATCH (e:Entity {name: $name})
      OPTIONAL MATCH (e)-[r:RELATES_TO]-(neighbor:Entity)
      RETURN e, collect(DISTINCT {
        entity: neighbor.name,
        relationship: r.type,
        direction: CASE WHEN startNode(r) = e THEN "outgoing" ELSE "incoming" END
      }) AS connections
      LIMIT 1
      `,
      { name },
    );
    if (result.records.length === 0) return null;

    const record = result.records[0];
    const entity = record.get("e");
    const connections = record.get("connections") as EntityConnection[];

    return {
      entity: {
        name: entity.properties.name as string,
        type: entity.properties.type as string,
        description: entity.properties.description as string | undefined,
        firstSeen: entity.properties.firstSeen as string | undefined,
        lastSeen: entity.properties.lastSeen as string | undefined,
        mentionCount: entity.properties.mentionCount as number | undefined,
      },
      connections: connections.filter((c) => c.entity != null),
    };
  } finally {
    await session.close();
  }
}

export async function getDocumentsByEntityMention(
  entityName: string,
): Promise<string[]> {
  const d = getDriver();
  if (!d) return [];

  const session = d.session();
  try {
    // Required index: Entity.name (see task #8 for index creation)
    const result = await session.run(
      `
      MATCH (d:Document)-[:MENTIONS]->(e:Entity {name: $entityName})
      RETURN d.id AS id
      LIMIT 100
      `,
      { entityName },
    );
    return result.records.map((record) => record.get("id") as string);
  } finally {
    await session.close();
  }
}

export async function closeDriver(): Promise<void> {
  if (driver) {
    await driver.close();
    driver = null;
  }
}
