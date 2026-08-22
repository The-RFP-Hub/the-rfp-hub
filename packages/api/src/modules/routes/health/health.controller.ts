import type { FastifyReply, FastifyRequest } from "fastify";
import { googleConfigured } from "../../../auth/better-auth.js";
import { config } from "../../../config.js";
import { HealthService } from "../../services/health/health.service.js";

/**
 * GET /v1/health — liveness, DB readiness, and which sign-in methods this deployment really has.
 *
 * `auth.google` is a CONFIGURATION READ, not a probe: it costs nothing, it cannot fail, and it is
 * the same predicate the auth instance itself uses to decide whether to register the provider. It
 * is here so a sign-in screen can advertise honestly instead of rendering a button, letting somebody
 * press it, and withdrawing it when the route 404s — which is what an attempt-based check looks like
 * to the person using it.
 *
 * Email is not reported: it is the method this deployment cannot be without, and a boolean that is
 * always true is a field that will eventually be wrong.
 */
const check = async (_req: FastifyRequest, res: FastifyReply) => {
  const service = new HealthService();
  const auth = { google: googleConfigured(config.google) };
  return (await service.ping())
    ? res.send({ status: "ok", db: "up", auth })
    : res.code(503).send({ status: "degraded", db: "down", auth });
};

export const healthController = { check };
