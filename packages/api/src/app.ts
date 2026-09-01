import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { SPEC_VERSION } from "@the-rfp-hub/standard";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import { authConfigFromEnvironment } from "./auth/better-auth.js";
import { config } from "./config.js";
import { pool } from "./db/client.js";
import { registerRoutes } from "./modules/routes/index.js";
import { RATE_LIMIT_HEADERS } from "./modules/routes/shared/rate-limit-key.js";
import { analyticsEvents } from "./modules/services/insights/event-buffer.js";
import { canonicalDocuments } from "./modules/shared/canonical-documents.js";
import { isHttpError } from "./modules/shared/http-error.js";
import { responseSchemas } from "./openapi/schemas.js";
import { registerAnalyticsContext } from "./plugins/analytics-context.js";
import { registerApexHostRule } from "./plugins/apex-host.js";
import { type AuthOptions, registerAuth } from "./plugins/auth.js";
import { AUTH_BASE_PATH, authCorsOptions, registerBetterAuth } from "./plugins/better-auth.js";
import { registerSwagger } from "./plugins/swagger.js";

export interface BuildOptions {
  /** Pass a Fastify logger config; defaults to off (tests) / on (server). */
  logger?: boolean;
  /**
   * Identity overrides. A deployment builds its session authority from the environment; the
   * integration suites inject their own instance over the test database, so they can sign
   * identities in with no network and no third party.
   */
  auth?: AuthOptions;
  /**
   * Close the shared pg pool when the app closes.
   *
   * THE SERVER SETS THIS; THE TESTS DO NOT, and the reason is ordering rather than tidiness. The
   * analytics buffer drains in an `onClose` hook and needs a LIVE pool to drain into, and Fastify
   * runs `onClose` hooks LIFO — so the pool hook has to be registered BEFORE the flush hook to run
   * AFTER it. Registering the pool close out here, after `buildApp` returned, put it last and
   * therefore first, and the shutdown flush wrote into a closed pool. Both hooks are registered
   * below, in one place, so the order is a decision that can be read.
   */
  closePool?: boolean;
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
    // What may be believed about `X-Forwarded-For`, and therefore what `request.ip` is. Never
    // `true`: the header is client-supplied, so blanket trust would let any caller choose the
    // address that ends up in an analytics hash or a rate-limit key. `undefined` trusts nothing.
    // See `readTrustProxy` in config.ts.
    trustProxy: config.trustProxy,
  });

  // Any origin, and now the write verbs too.
  //
  // `credentials: false` is the load-bearing half. EVERY credential this API accepts is
  // header-borne — `Authorization: Bearer …` for a session token or an API key — so a cross-site
  // request carries no ambient authority: a browser will not attach anything the attacker's page
  // does not already possess, and a page that possesses the token did not need CORS to use it.
  //
  // THE INVARIANT: this is only safe while no credential is a cookie. Introducing one turns `*`
  // into a cross-site request forgery surface and forces this to become an explicit origin
  // allowlist with `credentials: true`. Stated here and in docs/auth.md because the change that
  // breaks it will not look like a CORS change.
  //
  // TWO POLICIES, ONE REGISTRATION. `/api/auth/*` mints credentials and exposes `set-auth-token`,
  // so it gets an EXACT-origin allowlist instead (see plugins/better-auth.ts for why, and for why
  // this is a delegator rather than a second `register`: @fastify/cors decorates the request
  // object unconditionally and throws on a second registration, even an encapsulated one).
  const authCors = authCorsOptions(opts.auth?.config ?? authConfigFromEnvironment());
  const publicCors = {
    origin: "*" as const,
    methods: ["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"],
    exposedHeaders: RATE_LIMIT_HEADERS,
    credentials: false,
    maxAge: 600,
  };
  await app.register(cors, {
    delegator: (request, callback) => {
      callback(null, request.url.startsWith(AUTH_BASE_PATH) ? authCors : publicCors);
    },
  });

  // Registered with `global: false`: no route is rate-limited by opting out, only by opting in.
  // A blanket limit here would cap the public read surface — the list, the feeds, the full-dataset
  // export — which is the traffic this project exists to serve, and would be measured per IP,
  // which behind a shared egress is one number for a whole organization. The write, auth and
  // redirect routes attach their own `config.rateLimit` where a limit is meaningful.
  await app.register(rateLimit, { global: false });

  // Shared response schemas → OpenAPI components + response serialization (before routes ref them).
  for (const schema of responseSchemas) app.addSchema(schema);

  app.setErrorHandler((error: FastifyError, request, reply) => {
    // A service-layer failure already knows its status, its stable code and its extra members. The
    // routes wrap their handlers so this is normally unreachable; it is the backstop for a throw
    // from a hook or a serializer, where no wrapper is in the way.
    if (isHttpError(error)) {
      // A 5xx is OURS, whoever raised it. A service that answers "the database is unreachable"
      // deserves the same log line as an uncaught throw would have got — without it the only trace
      // of an outage is a status code on somebody else's dashboard.
      if (error.status >= 500) request.log.error(error);
      reply.code(error.status).send(error.toBody());
      return;
    }
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

  // ── shutdown order, decided here because it cannot be decided anywhere else ─────
  // Fastify runs `onClose` hooks LIFO, so these two read backwards: the pool hook is registered
  // FIRST so it runs LAST, and the analytics flush registered SECOND runs FIRST — against a pool
  // that is still open. A buffered event is lost on a crash by design, but losing one to our own
  // orderly shutdown would be a bug.
  if (opts.closePool) {
    app.addHook("onClose", async () => {
      await pool.end();
    });
  }
  analyticsEvents.reopen();
  app.addHook("onClose", async () => {
    await analyticsEvents.close();
  });

  // Decorated on the ROOT instance, before the routes, so every route module can read `app.auth`.
  // Fastify encapsulation would otherwise scope the decorators to whichever plugin declared them.
  const decorators = registerAuth(app, opts.auth);
  // AFTER the global `/v1` CORS (so the narrow policy is registered in its own encapsulated scope
  // rather than widened by it) and BEFORE the routes. Everything it registers — a raw-body parser,
  // a second CORS policy, two hidden routes — stays inside that scope.
  await app.register(registerBetterAuth, {
    auth: decorators.auth,
    config: opts.auth?.config ?? authConfigFromEnvironment(),
  });
  // Same reason, and it CAPTURES NOTHING — it only supplies the per-request context that the
  // controllers' explicit capture calls read. See plugins/analytics-context.ts.
  registerAnalyticsContext(app);

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
        "/v1/opportunities/:id/audit",
        "/v1/opportunities/:id/duplicates",
        "/v1/opportunities/:id/verification",
        "/v1/opportunities/:id/claim",
        "/v1/feeds/opportunities.atom",
        "/v1/feeds/opportunities.rss",
        "/v1/export/opportunities.json",
        "/v1/export/opportunities.csv",
        "/v1/stats",
        "/v1/health",
        "/v1/publishers",
        "/v1/r/:id/apply",
        "/v1/r/:id/source",
        "/v1/me",
        "/v1/me/opportunities",
        "/v1/me/duplicates",
        "/v1/keys",
        "/v1/insights/opportunities/:id",
        "/v1/insights/me/summary",
        "/v1/review/opportunities",
        "/v1/review/duplicates",
        "/v1/review/claims",
        "/v1/review/organizations",
        "/v1/review/accounts",
        "/v1/admin/accounts/:id/role",
        "/v1/admin/accounts/:id/direct-create",
        "/v1/admin/opportunities/:id/verify",
        "/v1/admin/jobs/:job/run",
        "/v1/organizations/:slug",
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
