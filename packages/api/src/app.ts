import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import { registerRoutes } from "./modules/routes/index.js";
import { responseSchemas } from "./openapi/schemas.js";
import { registerSwagger } from "./plugins/swagger.js";

export interface BuildOptions {
  /** Pass a Fastify logger config; defaults to off (tests) / on (server). */
  logger?: boolean;
}

/** Build the Fastify app (no network bind) — used by both the server and the integration tests. */
export async function buildApp(opts: BuildOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false });

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

  await registerSwagger(app); // before routes so their schemas are captured
  await registerRoutes(app);

  app.get("/", { schema: { tags: ["meta"], summary: "Service info" } }, async () => ({
    name: "RFP Hub API",
    version: "v1",
    standard: "1.0.0",
    docs: "/v1/docs",
    endpoints: [
      "/v1/opportunities",
      "/v1/opportunities/:id",
      "/v1/opportunities/schema",
      "/v1/stats",
      "/v1/health",
    ],
  }));

  return app;
}
