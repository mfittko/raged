export const ingestSchema = {
  body: {
    type: "object" as const,
    required: ["items"],
    properties: {
      collection: { type: "string" as const },
      items: {
        type: "array" as const,
        minItems: 1,
        items: {
          type: "object" as const,
          required: ["text", "source"],
          properties: {
            id: { type: "string" as const },
            text: { type: "string" as const, minLength: 1 },
            source: { type: "string" as const, minLength: 1 },
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
    required: ["query"],
    properties: {
      collection: { type: "string" as const },
      query: { type: "string" as const, minLength: 1 },
      topK: { type: "integer" as const, minimum: 1, maximum: 100 },
      filter: { type: "object" as const },
    },
  },
};
