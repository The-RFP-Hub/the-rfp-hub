import type { FastifyInstance } from "fastify";
import { healthController } from "./health.controller.js";

export const health = async (router: FastifyInstance): Promise<void> => {
  router.get(
    "/",
    {
      schema: {
        tags: ["meta"],
        summary: "Health check",
        response: { 200: { $ref: "Health#" }, 503: { $ref: "Health#" } },
      },
    },
    healthController.check,
  );
};
