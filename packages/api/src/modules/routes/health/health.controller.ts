import type { FastifyReply, FastifyRequest } from "fastify";
import { HealthService } from "../../services/health/health.service.js";

/** GET /v1/health — liveness + DB readiness. */
const check = async (_req: FastifyRequest, res: FastifyReply) => {
  const service = new HealthService();
  return (await service.ping())
    ? res.send({ status: "ok", db: "up" })
    : res.code(503).send({ status: "degraded", db: "down" });
};

export const healthController = { check };
