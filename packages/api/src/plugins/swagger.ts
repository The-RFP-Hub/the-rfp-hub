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
      // ONE scheme for both credential kinds, because one header carries both: a bearer value
      // starting `rfph_` is an API key and anything else is a session token. The distinction is
      // made on the token itself rather than on a header the caller chooses, which is what keeps
      // the session-only routes session-only. See modules/shared/api-key-token.ts.
      components: {
        securitySchemes: {
          bearerAuth: {
            type: "http",
            scheme: "bearer",
            description:
              "`Authorization: Bearer <token>` — either a signed-in session access token or an API key (`rfph_<prefix>_<secret>`). Key management, identity changes, review and administration accept a session only.",
          },
        },
      },
      tags: [
        { name: "opportunities", description: "Funding opportunities" },
        { name: "feeds", description: "Syndication feeds (Atom 1.0, RSS 2.0)" },
        { name: "export", description: "Full-dataset downloads (JSON, CSV)" },
        { name: "stats", description: "Dataset statistics" },
        { name: "meta", description: "Service metadata" },
        {
          name: "auth",
          description:
            "API-key lifecycle. Session-only: a key may never mint or revoke a key, because a key that could would mint a stronger one.",
        },
        { name: "account", description: "The authenticated account and its own entries" },
        {
          name: "submissions",
          description:
            "Creating, replacing and claiming entries. The server sets every provenance attribution field itself.",
        },
        { name: "review", description: "Reviewer surface — the queue, claims and organisations" },
        { name: "admin", description: "Administrator surface — roles and direct-create grants" },
        { name: "publishers", description: "Verified publishing organisations" },
        {
          name: "spec",
          description:
            "The RFP Hub Standard's own documents, served at the canonical URLs their identifiers name. Unversioned by the API on purpose — an identifier must not carry an API version.",
        },
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
