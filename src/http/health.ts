import type { FastifyInstance } from "fastify";
import type { RequestDrain } from "./request-drain.js";

export async function registerHealthRoutes(
  app: FastifyInstance,
  drain: RequestDrain,
): Promise<void> {
  app.get("/health/live", async () => ({ status: "ok" as const }));
  app.get("/health/ready", async (_request, reply) =>
    drain.status().draining ? reply.code(503).send({ status: "draining" }) : { status: "ready" },
  );
}
