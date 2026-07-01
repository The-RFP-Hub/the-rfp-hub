import type { FastifyInstance } from "fastify";
import { Module } from "./opportunity.module.js";
import { listQuerySchema } from "./types.js";

/** Registers the /v1/opportunities routes (mounted with that prefix by the aggregator). */
export const opportunities = async (router: FastifyInstance): Promise<void> => {
  router.get(
    "/",
    {
      schema: {
        tags: ["opportunities"],
        summary: "List opportunities (thin projection)",
        querystring: listQuerySchema,
      },
    },
    Module.getAll,
  );

  // static `/schema` is matched ahead of the `/:id` param route by the router
  router.get(
    "/schema",
    { schema: { tags: ["opportunities"], summary: "The RFP Hub Standard JSON Schema" } },
    Module.schema,
  );

  router.get(
    "/:id",
    {
      schema: {
        tags: ["opportunities"],
        summary: "Get one opportunity (full Standard object)",
        params: {
          type: "object",
          properties: { id: { type: "string", description: "Public id, e.g. fundingmap:1459" } },
          required: ["id"],
        },
      },
    },
    Module.find,
  );
};
