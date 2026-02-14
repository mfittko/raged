import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

export function registerAuth(app: FastifyInstance) {
  const token = process.env.RAG_API_TOKEN || "";
  if (!token) return;

  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.method === "GET" && req.url.startsWith("/healthz")) return;

    const auth = (req.headers["authorization"] || "").toString();
    const prefix = "Bearer ";
    if (!auth.startsWith(prefix)) return reply.code(401).send({ error: "Unauthorized" });

    const provided = auth.slice(prefix.length);
    if (!timingSafeEqual(provided, token)) return reply.code(401).send({ error: "Unauthorized" });
  });
}
