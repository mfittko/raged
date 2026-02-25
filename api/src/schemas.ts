export const ingestSchema = {
  body: {
    type: "object" as const,
    additionalProperties: false as const,
    required: ["items"],
    properties: {
      collection: { type: "string" as const },
      enrich: { type: "boolean" as const },
      overwrite: { type: "boolean" as const },
      items: {
        type: "array" as const,
        minItems: 1,
        maxItems: 1000,
        items: {
          type: "object" as const,
          required: [],  // Conditional validation in preValidation hook
          properties: {
            id: { type: "string" as const },
            text: { type: "string" as const, minLength: 1, pattern: "\\S" },
            url: { type: "string" as const, format: "uri", pattern: "^https?://" },
            source: { type: "string" as const, minLength: 1, pattern: "\\S" },
            rawData: { type: "string" as const, minLength: 1 },
            rawMimeType: { type: "string" as const, minLength: 1 },
            docType: {
              type: "string" as const,
              enum: ["code", "slack", "email", "meeting", "pdf", "image", "article", "text"],
            },
            metadata: { type: "object" as const },
          },
        },
      },
    },
  },
};

const queryBodyProperties = {
  collection: { type: "string" as const },
  query: { type: "string" as const, minLength: 1, pattern: "\\S" },
  topK: { type: "integer" as const, minimum: 1, maximum: 100 },
  minScore: { type: "number" as const, minimum: 0, maximum: 1 },
  filter: { type: "object" as const },
};

export const querySchema = {
  body: {
    type: "object" as const,
    additionalProperties: false as const,
    required: ["query"],
    properties: {
      ...queryBodyProperties,
      graphExpand: { type: "boolean" as const },
      graph: {
        type: "object" as const,
        additionalProperties: false as const,
        properties: {
          maxDepth: { type: "integer" as const, minimum: 1, maximum: 4 },
          maxEntities: { type: "integer" as const, minimum: 1, maximum: 500 },
          relationshipTypes: {
            type: "array" as const,
            maxItems: 20,
            items: { type: "string" as const },
          },
          includeDocuments: { type: "boolean" as const },
          seedEntities: {
            type: "array" as const,
            maxItems: 50,
            items: { type: "string" as const },
          },
        },
      },
    },
  },
};

export const queryDownloadFirstSchema = {
  body: {
    type: "object" as const,
    additionalProperties: false as const,
    required: ["query"],
    properties: queryBodyProperties,
  },
};

export const enrichmentStatusSchema = {
  params: {
    type: "object" as const,
    required: ["baseId"],
    properties: {
      baseId: { type: "string" as const, minLength: 1 },
    },
  },
  querystring: {
    type: "object" as const,
    properties: {
      collection: { type: "string" as const },
    },
  },
};

export const enrichmentStatsSchema = {
  querystring: {
    type: "object" as const,
    additionalProperties: false as const,
    properties: {
      collection: { type: "string" as const },
      filter: { type: "string" as const, minLength: 1 },
    },
  },
};

export const enrichmentEnqueueSchema = {
  body: {
    type: "object" as const,
    additionalProperties: false as const,
    properties: {
      collection: { type: "string" as const },
      force: { type: "boolean" as const },
      filter: { type: "string" as const, minLength: 1 },
    },
  },
};

export const enrichmentClearSchema = {
  body: {
    type: "object" as const,
    additionalProperties: false as const,
    properties: {
      collection: { type: "string" as const },
      filter: { type: "string" as const, minLength: 1 },
    },
  },
};

export const graphEntitySchema = {
  params: {
    type: "object" as const,
    required: ["name"],
    properties: {
      name: { type: "string" as const, minLength: 1 },
    },
  },
  querystring: {
    type: "object" as const,
    additionalProperties: false as const,
    properties: {
      limit: { type: "integer" as const, minimum: 1, maximum: 500, default: 100 },
    },
  },
};

// Internal endpoint schemas for worker communication
export const internalTaskClaimSchema = {
  body: {
    type: "object" as const,
    additionalProperties: false as const,
    properties: {
      workerId: {
        type: "string" as const,
        minLength: 1,
        default: "unknown",
        description: "Optional worker identifier; defaults to 'unknown' when omitted.",
      },
      leaseDuration: {
        type: "integer" as const,
        minimum: 1,
        maximum: 3600,
        default: 300,
        description: "Optional lease duration in seconds; defaults to 300 when omitted.",
      },
    },
  },
};

export const internalTaskResultSchema = {
  params: {
    type: "object" as const,
    required: ["id"],
    properties: {
      id: { type: "string" as const, minLength: 1 },
    },
  },
  body: {
    type: "object" as const,
    required: ["chunkId", "collection"],
    properties: {
      chunkId: { type: "string" as const, minLength: 1 },
      collection: { type: "string" as const, minLength: 1 },
      tier2: { type: "object" as const },
      tier3: { type: "object" as const },
      entities: {
        type: "array" as const,
        items: {
          type: "object" as const,
          required: ["name", "type"],
          properties: {
            name: { type: "string" as const },
            type: { type: "string" as const },
            description: { type: "string" as const },
          },
        },
      },
      relationships: {
        type: "array" as const,
        items: {
          type: "object" as const,
          required: ["source", "target", "type"],
          properties: {
            source: { type: "string" as const },
            target: { type: "string" as const },
            type: { type: "string" as const },
            description: { type: "string" as const },
          },
        },
      },
      summary: { type: "string" as const },
    },
  },
};

export const internalTaskFailSchema = {
  params: {
    type: "object" as const,
    required: ["id"],
    properties: {
      id: { type: "string" as const, minLength: 1 },
    },
  },
  body: {
    type: "object" as const,
    required: ["error"],
    properties: {
      error: { type: "string" as const, minLength: 1 },
    },
  },
};
