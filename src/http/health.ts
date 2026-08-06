import type { FastifyInstance } from "fastify";

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health/live", async () => ({ status: "ok" as const }));
  app.get("/health/ready", async () => ({ status: "ready" as const }));
}
