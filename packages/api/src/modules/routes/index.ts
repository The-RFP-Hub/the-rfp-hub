import type { FastifyInstance } from "fastify";
import { canonical } from "./canonical/index.js";
import { datasetExport } from "./export/index.js";
import { feeds } from "./feeds/index.js";
import { health } from "./health/index.js";
import { keys } from "./keys/index.js";
import { me } from "./me/index.js";
import { opportunities } from "./opportunities/index.js";
import { specArtifactMirror } from "./spec-artifacts/index.js";
import { stats } from "./stats/index.js";

/** Mounts every route module under its /v1 prefix — except the spec's own documents. */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  await app.register(opportunities, { prefix: "/v1/opportunities" });
  await app.register(feeds, { prefix: "/v1/feeds" });
  // `export` is a reserved word, so the module's binding is `datasetExport`; the PREFIX is the
  // singular `/v1/export`, symmetric with `/v1/feeds` — one noun naming what the routes under it do.
  await app.register(datasetExport, { prefix: "/v1/export" });
  await app.register(stats, { prefix: "/v1/stats" });
  await app.register(health, { prefix: "/v1/health" });
  await app.register(me, { prefix: "/v1/me" });
  await app.register(keys, { prefix: "/v1/keys" });
  // No prefix, deliberately: these routes ARE the spec's identifiers, and an identifier must
  // not carry an API version. See modules/shared/canonical-documents.ts and adr/0007.
  await app.register(canonical);
  // The rest of the directories those identifiers live in, mirrored read-only at the same root —
  // the publication tree adr/0007 describes. Registered after `canonical`, which owns the five
  // identifier paths; this module skips them rather than redeclaring them.
  await app.register(specArtifactMirror);
}
