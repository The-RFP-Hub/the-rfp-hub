import type { FastifyInstance } from "fastify";
import { Module } from "./health.module.js";

export const health = async (router: FastifyInstance): Promise<void> => {
  router.get("/", { schema: { tags: ["meta"], summary: "Health check" } }, Module.check);
};
