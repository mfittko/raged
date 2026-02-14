import type { FastifyInstance, FastifyError, FastifyRequest, FastifyReply } from "fastify";

export interface StructuredError {
  error: string;
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler(
    async (error: FastifyError, _request: FastifyRequest, reply: FastifyReply) => {
      const statusCode = error.statusCode ?? 500;

      // Fastify validation errors (JSON Schema)
      if (error.validation) {
        return reply.code(400).send({
          error: `Validation failed: ${error.message}`,
        });
      }

      // Upstream service errors (Ollama, Qdrant) — surface as 502
      const upstreamError = error as FastifyError & { code?: string };
      if (
        upstreamError.code === "UPSTREAM_SERVICE_ERROR" ||
        upstreamError.name === "UpstreamServiceError"
      ) {
        return reply.code(502).send({
          error: `Upstream service error: ${error.message}`,
        });
      }

      // Auth errors are already handled by auth.ts hook (401)
      // Any other error with a status code
      if (statusCode >= 400 && statusCode < 500) {
        return reply.code(statusCode).send({
          error: error.message,
        });
      }

      // Internal server errors — do NOT expose stack traces
      app.log.error(error);
      return reply.code(500).send({
        error: "Internal server error",
      });
    },
  );
}
