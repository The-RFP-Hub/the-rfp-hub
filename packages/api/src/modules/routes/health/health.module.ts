import { sql } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import { db } from "../../../db/client.js";

/** GET /v1/health — liveness + DB readiness. */
const check = async (_req: FastifyRequest, res: FastifyReply) => {
  try {
    await db.execute(sql`SELECT 1`);
    return res.send({ status: "ok", db: "up" });
  } catch {
    return res.code(503).send({ status: "degraded", db: "down" });
  }
};

export const Module = { check };
