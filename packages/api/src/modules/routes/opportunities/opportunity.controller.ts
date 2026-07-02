import { SPEC_VERSION, opportunitySchema } from "@rfp-hub/standard";
import type { FastifyReply, FastifyRequest } from "fastify";
import { OpportunityService } from "../../services/opportunity.service.js";
import { type RawQuery, parseOpportunityQuery } from "./types.js";

/** GET /v1/opportunities — filtered, sorted, paginated thin list. */
const getAll = async (req: FastifyRequest, res: FastifyReply) => {
  const service = new OpportunityService();
  const query = parseOpportunityQuery(req.query as RawQuery);
  return res.send(await service.getAll(query));
};

/** GET /v1/opportunities/:id — full Standard object, or 404. */
const find = async (req: FastifyRequest, res: FastifyReply) => {
  const { id } = req.params as { id: string };
  const service = new OpportunityService();
  const opportunity = await service.find(id);
  if (!opportunity) {
    return res.code(404).send({ error: "not_found", message: `opportunity '${id}' not found` });
  }
  return res.send(opportunity);
};

/** GET /v1/opportunities/schema — the canonical RFP Hub Standard JSON Schema. */
const schema = async (_req: FastifyRequest, res: FastifyReply) => {
  return res.send({ specVersion: SPEC_VERSION, schema: opportunitySchema });
};

export const opportunityController = { getAll, find, schema };
