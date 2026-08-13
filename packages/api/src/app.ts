import cors from "@fastify/cors";
import { SPEC_VERSION } from "@the-rfp-hub/standard";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import { registerRoutes } from "./modules/routes/index.js";
import { canonicalDocuments } from "./modules/shared/canonical-documents.js";
import { responseSchemas } from "./openapi/schemas.js";
import { registerApexHostRule } from "./plugins/apex-host.js";
import { registerSwagger } from "./plugins/swagger.js";

export interface BuildOptions {
  /** Pass a Fastify logger config; defaults to off (tests) / on (server). */
  logger?: boolean;
}

/** Build the Fastify app (no network bind) — used by both the server and the integration tests. */
export async function buildApp(opts: BuildOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? false,
    // Route modules mount their index as "/" under a prefix. Without this Fastify would register
    // AND publish the trailing-slash variant ("/v1/opportunities/"), which is not the form the
    // docs advertise; with it only the canonical no-slash path is registered/published, while a
    // stray trailing slash still resolves to it instead of 404ing.
    // `routerOptions` is a 5.8-era option (the flat `ignoreTrailingSlash` is deprecated); an older
    // 5.x would treat this as an unknown top-level key and silently ignore it, so package.json's
    // range floor is pinned accordingly.
    routerOptions: { ignoreTrailingSlash: true },
    // Fastify's ajv defaults to removeAdditional:true, which STRIPS unknown querystring keys
    // before `additionalProperties: false` can reject them — a misspelled filter would silently
    // return the whole dataset. Turn it off so the schema's strictness actually reaches the client.
    ajv: { customOptions: { removeAdditional: false } },
  });

  // Fully public, unauthenticated read API — no browser client can call it today because no
  // response carries CORS headers. Any origin is allowed, and only the read-safe verbs are
  // permitted (this API never mutates), so there are no credentials to protect and no origin
  // allowlist to maintain.
  await app.register(cors, { origin: "*", methods: ["GET", "HEAD", "OPTIONS"] });

  // Shared response schemas → OpenAPI components + response serialization (before routes ref them).
  for (const schema of responseSchemas) app.addSchema(schema);

  app.setErrorHandler((error: FastifyError, request, reply) => {
    // Schema/validation failures stay 400 with a safe message.
    if (error.validation) {
      reply.code(400).send({ error: "bad_request", message: error.message });
      return;
    }
    // Preserve explicitly-thrown client (4xx) errors.
    const statusCode = error.statusCode ?? 500;
    if (statusCode >= 400 && statusCode < 500) {
      reply.code(statusCode).send({ error: "client_error", message: error.message });
      return;
    }
    // Unexpected (5xx / uncaught) → log the real cause, return a generic body (no internals leaked).
    request.log.error(error);
    reply.code(500).send({ error: "internal_error", message: "internal server error" });
  });

  app.setNotFoundHandler((request, reply) => {
    reply
      .code(404)
      .send({ error: "not_found", message: `route ${request.method} ${request.url} not found` });
  });

  // The apex is reserved for the spec (adr/0007). On that hostname this service answers the
  // canonical documents and nothing else — registered on the root instance, before the routes,
  // so it covers every route the service has or gains.
  registerApexHostRule(app);

  await registerSwagger(app); // before routes so their schemas are captured
  await registerRoutes(app);

  app.get(
    "/",
    { schema: { operationId: "getServiceInfo", tags: ["meta"], summary: "Service info" } },
    async () => ({
      name: "RFP Hub API",
      version: "v1",
      standard: SPEC_VERSION,
      docs: "/v1/docs",
      endpoints: [
        "/v1/opportunities",
        "/v1/opportunities/:id",
        "/v1/opportunities/schema",
        "/v1/feeds/opportunities.atom",
        "/v1/feeds/opportunities.rss",
        "/v1/export/opportunities.json",
        "/v1/export/opportunities.csv",
        "/v1/stats",
        "/v1/health",
      ],
      // The spec's own documents, at the paths their identifiers name (adr/0007).
      spec: canonicalDocuments.map((doc) => doc.path),
      // Feed autodiscovery. There is no HTML page here to carry the usual
      // `<link rel="alternate" type="application/atom+xml">`, so the service-info document is what
      // an agent (or a human pointing a reader at the API root) reads instead — same three facts a
      // discovery link carries: relation, media type, href.
      feeds: [
        { rel: "alternate", type: "application/atom+xml", href: "/v1/feeds/opportunities.atom" },
        { rel: "alternate", type: "application/rss+xml", href: "/v1/feeds/opportunities.rss" },
      ],
    }),
  );

  return app;
}
