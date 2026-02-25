/**
 * GraphBackend interface and domain types for graph traversal.
 * Implementations provide all graph data access — no SQL in callers.
 */

export interface ResolvedEntity {
  id: string;
  name: string;
  type: string;
  description?: string;
  mentionCount?: number;
}

export interface TraversalEntity {
  id: string;
  name: string;
  type: string;
  depth: number;
  isSeed: boolean;
  mentionCount?: number;
}

export interface Edge {
  source: string;
  target: string;
  type: string;
}

export interface EntityPath {
  entities: string[];
  relationships: string[];
  depth: number;
}

export interface EntityDocument {
  documentId: string;
  source: string;
  entityName: string;
  mentionCount: number;
}

export interface TraversalMeta {
  seedEntities: string[];
  seedSource: "results" | "explicit";
  maxDepthUsed: number;
  entityCount: number;
  entityCap: number;
  capped: boolean;
  timeLimitMs: number;
  timedOut: boolean;
  warnings: string[];
}

export interface TraversalResult {
  entities: TraversalEntity[];
  relationships: Edge[];
  paths: EntityPath[];
  documents: EntityDocument[];
  meta: TraversalMeta;
}

export interface TraversalParams {
  maxDepth: number;
  maxEntities: number;
  relationshipTypes: string[];
  includeDocuments: boolean;
  timeLimitMs: number;
}

export interface EntityRelationship {
  entityName: string;
  relationship: string;
  direction: "outbound" | "inbound";
  description?: string;
}

export interface GraphResult {
  entities: Array<{
    name: string;
    type: string;
    depth: number;
    isSeed: boolean;
    mentionCount?: number;
  }>;
  relationships: Edge[];
  paths: EntityPath[];
  documents: EntityDocument[];
  meta: TraversalMeta;
}

export interface GraphBackend {
  resolveEntities(names: string[]): Promise<ResolvedEntity[]>;
  traverse(seedIds: string[], params: TraversalParams): Promise<TraversalResult>;
  getEntityDocuments(entityIds: string[], limit: number): Promise<EntityDocument[]>;
  getEntity(name: string): Promise<ResolvedEntity | null>;
  getEntityRelationships(entityId: string, limit: number): Promise<EntityRelationship[]>;
}
