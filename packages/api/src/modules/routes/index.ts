import type { FastifyInstance } from "fastify";
import { canonical } from "./canonical/index.js";
import { feeds } from "./feeds/index.js";
import { health } from "./health/index.js";
import { opportunities } from "./opportunities/index.js";
import { stats } from "./stats/index.js";

/** Mounts every route module under its /v1 prefix — except the spec's own documents. */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  await app.register(opportunities, { prefix: "/v1/opportunities" });
  await app.register(feeds, { prefix: "/v1/feeds" });
  await app.register(stats, { prefix: "/v1/stats" });
  await app.register(health, { prefix: "/v1/health" });
  // No prefix, deliberately: these routes ARE the spec's identifiers, and an identifier must
  // not carry an API version. See modules/shared/canonical-documents.ts and adr/0007.
  await app.register(canonical);
}
