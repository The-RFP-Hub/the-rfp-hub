import swagger from "@fastify/swagger";
import swaggerUI from "@fastify/swagger-ui";
import type { FastifyInstance } from "fastify";
import { config } from "../config.js";

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
        license: { name: "MIT", identifier: "MIT" },
      },
      // Driven by PUBLIC_BASE_URL (default "/" — relative, correct wherever the server is hosted).
      // A deployed environment sets it to the API's OWN https:// origin; see config.ts.
      servers: [{ url: config.publicBaseUrl }],
      tags: [
        { name: "opportunities", description: "Funding opportunities" },
        { name: "feeds", description: "Syndication feeds (Atom 1.0, RSS 2.0)" },
        { name: "stats", description: "Dataset statistics" },
        { name: "meta", description: "Service metadata" },
      ],
    },
    // Name components by their $id (Opportunity, Stats, …) instead of the default def-0/def-1/…
    refResolver: {
      buildLocalReference(json, _baseUri, fragment, i) {
        return (typeof json.$id === "string" && json.$id) || `def-${i}`;
      },
    },
  });

  await app.register(swaggerUI, {
    routePrefix: "/v1/docs",
    uiConfig: { docExpansion: "list", deepLinking: true },
  });
}
