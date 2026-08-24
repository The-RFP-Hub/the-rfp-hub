import type { FastifyInstance } from "fastify";
import { admin } from "./admin/index.js";
import { canonical } from "./canonical/index.js";
import { datasetExport } from "./export/index.js";
import { feeds } from "./feeds/index.js";
import { health } from "./health/index.js";
import { insights } from "./insights/index.js";
import { keys } from "./keys/index.js";
import { me } from "./me/index.js";
import { opportunities } from "./opportunities/index.js";
import { opportunityMeta } from "./opportunity-meta/index.js";
import { organizations } from "./organizations/index.js";
import { publishers } from "./publishers/index.js";
import { redirects } from "./redirects/index.js";
import { review } from "./review/index.js";
import { specArtifactMirror } from "./spec-artifacts/index.js";
import { stats } from "./stats/index.js";
import { submissions } from "./submissions/index.js";

/** Mounts every route module under its /v1 prefix — except the spec's own documents. */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  await app.register(opportunities, { prefix: "/v1/opportunities" });
  // Three plugins share the `/v1/opportunities` prefix, and the split is deliberate rather than
  // organisational: `opportunities` carries the JSON-LD context hook, which instructs a conformant
  // processor to read the body as a Standard opportunity. A submission result, a claim decision and
  // an audit trail are not opportunities, so they must not be advertised as ones — and Fastify
  // encapsulation makes the plugin boundary the hook boundary. See modules/shared/jsonld-link.ts.
  await app.register(submissions, { prefix: "/v1/opportunities" });
  await app.register(opportunityMeta, { prefix: "/v1/opportunities" });
  await app.register(feeds, { prefix: "/v1/feeds" });
  // `export` is a reserved word, so the module's binding is `datasetExport`; the PREFIX is the
  // singular `/v1/export`, symmetric with `/v1/feeds` — one noun naming what the routes under it do.
  await app.register(datasetExport, { prefix: "/v1/export" });
  await app.register(stats, { prefix: "/v1/stats" });
  await app.register(health, { prefix: "/v1/health" });
  await app.register(me, { prefix: "/v1/me" });
  await app.register(keys, { prefix: "/v1/keys" });
  await app.register(review, { prefix: "/v1/review" });
  await app.register(admin, { prefix: "/v1/admin" });
  await app.register(publishers, { prefix: "/v1/publishers" });
  await app.register(organizations, { prefix: "/v1/organizations" });
  await app.register(insights, { prefix: "/v1/insights" });
  // Short on purpose: `/v1/r/:id/apply` is a URL that ends up in emails, newsletters and social
  // posts, and every character of it is carried by whoever pastes it.
  await app.register(redirects, { prefix: "/v1/r" });
  // No prefix, deliberately: these routes ARE the spec's identifiers, and an identifier must
  // not carry an API version. See modules/shared/canonical-documents.ts and adr/0007.
  await app.register(canonical);
  // The rest of the directories those identifiers live in, mirrored read-only at the same root —
  // the publication tree adr/0007 describes. Registered after `canonical`, which owns the five
  // identifier paths; this module skips them rather than redeclaring them.
  await app.register(specArtifactMirror);
}
