import type { FastifyInstance } from "fastify";
import { feeds } from "./feeds/index.js";
import { health } from "./health/index.js";
import { opportunities } from "./opportunities/index.js";
import { stats } from "./stats/index.js";

/** Mounts every route module under its /v1 prefix. */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  await app.register(opportunities, { prefix: "/v1/opportunities" });
  await app.register(feeds, { prefix: "/v1/feeds" });
  await app.register(stats, { prefix: "/v1/stats" });
  await app.register(health, { prefix: "/v1/health" });
}
