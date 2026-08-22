import type { FastifyReply, FastifyRequest } from "fastify";
import { OpportunityService } from "../../services/opportunities/opportunity.service.js";
import { captureViews } from "../../shared/analytics-capture.js";
import { REVALIDATE_CACHE, opportunitySchemaDocument } from "../../shared/canonical-documents.js";
import { sendCanonical } from "../canonical/index.js";
import { type RawQuery, parseOpportunityQuery } from "./types.js";

/**
 * GET /v1/opportunities — filtered, sorted, paginated thin list.
 *
 * The capture call is HERE, not in a response hook, and that is forced rather than stylistic: the
 * ids exist only in the service's result, which is handed straight to `res.send`. A hook sees a
 * serialized payload and a URL, so it could record "somebody listed something" and nothing more.
 */
const getAll = async (req: FastifyRequest, res: FastifyReply) => {
  const service = new OpportunityService();
  const query = parseOpportunityQuery(req.query as RawQuery);
  const page = await service.getAll(query);
  // One event per row on the page — a list view credits every entry that was actually shown.
  captureViews(
    req,
    "list_view",
    page.items.map((item) => item.id),
  );
  return res.send(page);
};

/** GET /v1/opportunities/:id — full Standard object, or 404. */
const find = async (req: FastifyRequest, res: FastifyReply) => {
  const { id } = req.params as { id: string };
  const service = new OpportunityService();
  const opportunity = await service.find(id);
  if (!opportunity) {
    return res.code(404).send({ error: "not_found", message: `opportunity '${id}' not found` });
  }
  // Only a served record is counted: a 404 is not a read of anything.
  captureViews(req, "detail_view", [opportunity.id]);
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
