import type { FastifyInstance } from "fastify";
import { statsController } from "./stats.controller.js";

export const stats = async (router: FastifyInstance): Promise<void> => {
  router.get(
    "/",
    {
      // Serve (and document) the prefix itself — /v1/stats, no trailing slash.
      prefixTrailingSlash: "no-slash",
      schema: {
        operationId: "getStats",
        tags: ["stats"],
        summary: "Dataset totals and breakdowns",
        response: { 200: { $ref: "Stats#" } },
      },
    },
    statsController.summary,
  );
};
