export const ingestSchema = {
  body: {
    type: "object" as const,
    additionalProperties: false as const,
    required: ["items"],
    properties: {
      collection: { type: "string" as const },
      enrich: { type: "boolean" as const },
      items: {
        type: "array" as const,
        minItems: 1,
        maxItems: 1000,
        items: {
          type: "object" as const,
          required: ["text", "source"],
          properties: {
            id: { type: "string" as const },
            text: { type: "string" as const, minLength: 1, pattern: "\\S" },
            source: { type: "string" as const, minLength: 1, pattern: "\\S" },
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

export const querySchema = {
  body: {
    type: "object" as const,
    additionalProperties: false as const,
    required: ["query"],
    properties: {
      collection: { type: "string" as const },
      query: { type: "string" as const, minLength: 1, pattern: "\\S" },
      topK: { type: "integer" as const, minimum: 1, maximum: 100 },
      filter: { type: "object" as const },
      graphExpand: { type: "boolean" as const },
    },
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

export const enrichmentEnqueueSchema = {
  body: {
    type: "object" as const,
    additionalProperties: false as const,
    properties: {
      collection: { type: "string" as const },
      force: { type: "boolean" as const },
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
};
