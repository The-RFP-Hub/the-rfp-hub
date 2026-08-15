import { and, eq } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import { db } from "../../../db/client.js";
import { opportunities } from "../../../db/schema.js";
import { captureViews } from "../../shared/analytics-capture.js";
import { notFound } from "../../shared/http-error.js";
import { handled, paramsOf } from "../../shared/route-helpers.js";

/** The two link-outs, and which stored column each one means. */
type LinkKind = "apply" | "source";

/**
 * Resolve one entry's stored link-out, or 404.
 *
 * THE PUBLIC PREDICATE IS PART OF THE QUERY, not a check afterwards: a redirect that resolved a
 * pending entry would confirm its existence and hand out its URL, which is exactly what the public
 * detail route refuses to do.
 */
async function resolveDestination(publicId: string, kind: LinkKind): Promise<string> {
  const rows = await db
    .select({
      applicationUrl: opportunities.applicationUrl,
      website: opportunities.website,
    })
    .from(opportunities)
    .where(
      and(
        eq(opportunities.publicId, publicId),
        eq(opportunities.reviewStatus, "approved"),
        eq(opportunities.isListed, true),
      ),
    )
    .limit(1);

  const row = rows[0];
  const stored = (kind === "apply" ? row?.applicationUrl : row?.website)?.trim();
  // One undifferentiated 404 for "no such entry", "not public" and "no link stored". Telling them
  // apart would answer questions about entries the public reads do not acknowledge.
  if (!stored) throw notFound(`no ${kind} link for ${JSON.stringify(publicId)}.`);

  let destination: URL;
  try {
    destination = new URL(stored);
  } catch {
    throw notFound(`no ${kind} link for ${JSON.stringify(publicId)}.`);
  }
  // A stored value is not automatically a safe one: this endpoint emits a `Location`, and a
  // `javascript:` or `data:` URL behind our own domain is a phishing primitive. Only the two web
  // schemes are ever handed back.
  if (destination.protocol !== "http:" && destination.protocol !== "https:") {
    throw notFound(`no ${kind} link for ${JSON.stringify(publicId)}.`);
  }
  return destination.href;
}

function redirector(kind: LinkKind) {
  return handled(async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = paramsOf<{ id: string }>(request);
    const destination = await resolveDestination(id, kind);
    captureViews(request, kind === "apply" ? "apply_click" : "source_click", [id]);
    // 302, not 301: a permanent redirect would be cached by the browser, and the second click on a
    // link would never reach this service to be counted — nor would a later change of destination.
    return reply.code(302).header("location", destination).send();
  });
}

export const redirectController = {
  apply: redirector("apply"),
  source: redirector("source"),
};
