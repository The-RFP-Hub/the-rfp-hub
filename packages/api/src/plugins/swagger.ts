import swagger from "@fastify/swagger";
import swaggerUI from "@fastify/swagger-ui";
import type { FastifyInstance } from "fastify";

/**
 * OpenAPI 3.1 spec (collected from route schemas) + Swagger UI at /v1/docs.
 * Must be registered BEFORE the routes so @fastify/swagger's onRoute hook captures them.
 */
export async function registerSwagger(app: FastifyInstance): Promise<void> {
  await app.register(swagger, {
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "RFP Hub API",
        version: "1.0.0",
        description:
          "Public, unauthenticated read API serving the RFP Hub Standard v1.0.0 — Ethereum-ecosystem funding opportunities.",
      },
      servers: [{ url: "/" }],
      tags: [
        { name: "opportunities", description: "Funding opportunities" },
        { name: "stats", description: "Dataset statistics" },
        { name: "meta", description: "Service metadata" },
      ],
    },
  });

  await app.register(swaggerUI, {
    routePrefix: "/v1/docs",
    uiConfig: { docExpansion: "list", deepLinking: true },
  });
}
