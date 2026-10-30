import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "../../../config.js";
import {
  OpportunityService,
  type PublicLink,
} from "../../services/opportunities/opportunity.service.js";
import { captureViews } from "../../shared/analytics-capture.js";
import { notFound } from "../../shared/http-error.js";
import { type LinkKind, leavingPageUrl, leavingReason } from "../../shared/link-out.js";
import { handled, paramsOf } from "../../shared/route-helpers.js";
import { isPublishableUrl } from "../../shared/url-policy.js";

const opportunityService = new OpportunityService();

/**
 * Resolve one entry's stored link-out, or 404.
 *
 * THE PUBLIC PREDICATE IS PART OF THE QUERY, not a check afterwards: a redirect that resolved a
 * pending entry would confirm its existence and hand out its URL, which is exactly what the public
 * detail route refuses to do.
 */
async function resolveDestination(
  publicId: string,
  kind: LinkKind,
): Promise<{ link: PublicLink; destination: string }> {
  const link = await opportunityService.findLink(publicId, kind);
  const stored = link?.stored.trim();
  // One undifferentiated 404 for "no such entry", "not public" and "no link stored". Telling them
  // apart would answer questions about entries the public reads do not acknowledge.
  if (!link || !stored) throw notFound(`no ${kind} link for ${JSON.stringify(publicId)}.`);

  let destination: URL;
  try {
    destination = new URL(stored);
  } catch {
    throw notFound(`no ${kind} link for ${JSON.stringify(publicId)}.`);
  }
  // A stored value is not automatically a safe one: this endpoint emits a `Location`, and a
  // `javascript:` or `data:` URL behind our own domain is a phishing primitive. The destination now
  // has to satisfy the SAME rule ingest applies (modules/shared/url-policy.ts) rather than a looser
  // one of its own, so the two cannot drift: `https:` anywhere, `http:` on loopback. Keeping the
  // check here at all is what covers rows that predate that policy — plaintext to a remote host
  // under our own counted redirect is a hop a network can rewrite.
  //
  // STILL A 404 WHEN THE LEAVING PAGE WOULD BE SHOWN. That page displays the destination and offers
  // to continue to it, so a URL we will not emit as a `Location` is not one to hand a reader there
  // either: the leaving page is for links that are safe to follow but not vouched for.
  if (!isPublishableUrl(stored)) {
    throw notFound(`no ${kind} link for ${JSON.stringify(publicId)}.`);
  }
  return { link, destination: destination.href };
}

function redirector(kind: LinkKind) {
  return handled(async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = paramsOf<{ id: string }>(request);
    const { link, destination } = await resolveDestination(id, kind);
    // Counted in BOTH outcomes below. The reader asked to leave for the programme's channel either
    // way, and a publisher's apply count must not drop because the hub asked a question on the way.
    captureViews(request, kind === "apply" ? "apply_click" : "source_click", [id]);
    // Vouched → the stored destination, exactly as before. Not vouched → the frontend's leaving
    // page, which names the destination and the reason; see `modules/shared/link-out.ts`. Both are
    // built from stored values and configuration, never from the request.
    const reason = leavingReason(kind, link);
    const location =
      reason === null
        ? destination
        : leavingPageUrl(config.appBaseUrl, link.publicId, kind, reason);
    // 302, not 301: a permanent redirect would be cached by the browser, and the second click on a
    // link would never reach this service to be counted — nor would a later change of destination,
    // or of whether we vouch for it.
    return reply.code(302).header("location", location).send();
  });
}

export const redirectController = {
  apply: redirector("apply"),
  source: redirector("source"),
};
