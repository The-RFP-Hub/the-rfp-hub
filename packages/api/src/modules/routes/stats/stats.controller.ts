import type { FastifyReply, FastifyRequest } from "fastify";
import { StatsService } from "../../services/stats.service.js";

/** GET /v1/stats — aggregate counts over the public dataset. */
const summary = async (_req: FastifyRequest, res: FastifyReply) => {
  const service = new StatsService();
  return res.send(await service.summary());
};

export const statsController = { summary };
