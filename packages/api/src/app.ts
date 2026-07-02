import Fastify, { type FastifyInstance } from "fastify";
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
