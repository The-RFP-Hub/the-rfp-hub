import type { FastifyReply, FastifyRequest } from "fastify";
import { HealthController } from "../../controller/Health.controller.js";

/** GET /v1/health — liveness + DB readiness. */
const check = async (_req: FastifyRequest, res: FastifyReply) => {
  const ctl = new HealthController();
  return (await ctl.ping())
    ? res.send({ status: "ok", db: "up" })
    : res.code(503).send({ status: "degraded", db: "down" });
};

export const Module = { check };
