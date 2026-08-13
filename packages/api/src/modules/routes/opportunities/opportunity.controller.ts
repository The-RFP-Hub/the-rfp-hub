import type { FastifyReply, FastifyRequest } from "fastify";
import { OpportunityService } from "../../services/opportunities/opportunity.service.js";
import { REVALIDATE_CACHE, opportunitySchemaDocument } from "../../shared/canonical-documents.js";
import { sendCanonical } from "../canonical/index.js";
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

/**
 * GET /v1/opportunities/schema — the canonical RFP Hub Standard JSON Schema, served verbatim
 * under the JSON Schema media type so a generic validator can `$ref` this URL directly. The
 * document self-identifies (`$id`, `$schema`), so no envelope is needed to carry the version.
 *
 * Same bytes, same module as the root-mounted canonical route: this one is the convenience for
 * a client already talking to `/v1/`, and the `$id` it carries points at the canonical URL, not
 * here. When spec serving moves to a CDN the canonical routes go and this one stays.
 *
 * It is cached with revalidation rather than as immutable, unlike the canonical schema URL it
 * mirrors: this path names no spec version, so its bytes change the day a new version becomes
 * current. Same document, same entity-tag, different promise about the URL.
 */
const schema = async (req: FastifyRequest, res: FastifyReply) =>
  sendCanonical({ ...opportunitySchemaDocument, cacheControl: REVALIDATE_CACHE }, req, res);

export const opportunityController = { getAll, find, schema };
