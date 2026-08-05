import type { FastifyInstance } from "fastify";
import { healthController } from "./health.controller.js";

export const health = async (router: FastifyInstance): Promise<void> => {
  router.get(
    "/",
    {
      // Serve (and document) the prefix itself — /v1/health, no trailing slash.
      prefixTrailingSlash: "no-slash",
      schema: {
        operationId: "getHealth",
        tags: ["meta"],
        summary: "Health check",
        response: { 200: { $ref: "Health#" }, 503: { $ref: "Health#" } },
      },
    },
    healthController.check,
  );
};
