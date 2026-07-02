import type { FastifyReply, FastifyRequest } from "fastify";
import { StatsController } from "../../controller/Stats.controller.js";

/** GET /v1/stats — aggregate counts over the public dataset. */
const summary = async (_req: FastifyRequest, res: FastifyReply) => {
  const ctl = new StatsController();
  return res.send(await ctl.summary());
};

export const Module = { summary };
