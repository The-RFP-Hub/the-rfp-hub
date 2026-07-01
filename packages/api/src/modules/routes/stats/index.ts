import type { FastifyInstance } from "fastify";
import { Module } from "./stats.module.js";

export const stats = async (router: FastifyInstance): Promise<void> => {
  router.get(
    "/",
    { schema: { tags: ["stats"], summary: "Dataset totals and breakdowns" } },
    Module.summary,
  );
};
