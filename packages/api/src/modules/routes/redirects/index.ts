/**
 * `/v1/r/:id/apply` and `/v1/r/:id/source` — the two measurable link-outs.
 *
 * WHY THESE EXIST. A view count says a record was read; it says nothing about whether the listing
 * did its job. The only server-observable signal for that is somebody leaving for the programme's
 * own page, and the only way to observe it without a client-side beacon is to be the hop.
 *
 * THE OPEN-REDIRECT RULE, which is the whole security surface of this module: the destination is
 * never taken from the request. It is read from the STORED row, it must be one of the two URL
 * columns of an entry that is `approved AND is_listed`, and its scheme must be http or https.
 * Anything else is a 404, not a redirect to an error page — an endpoint that will emit a `Location`
 * a caller supplied is a phishing primitive wearing this project's domain.
 *
 * A DOCUMENTED REDIRECT, DELIBERATELY. The alternative — leaving these out of the OpenAPI document
 * to keep the nightly compliance run green — would mean shipping an undocumented public endpoint,
 * which is worse than a checker that does not understand redirects. The checker was taught to
 * validate a 3xx by its `Location`, status and scheme first (it no longer follows redirects), and
 * only then did these routes ship. The `Location` header is declared below for the same reason: it
 * is what tells a generated client this is a link-out rather than an empty response.
 *
 * No JSON-LD hook and no `application/json` body at all, so nothing here can be advertised as a
 * Standard opportunity.
 */
import type { FastifyInstance } from "fastify";
import { redirectController } from "./redirect.controller.js";

export const redirects = async (router: FastifyInstance): Promise<void> => {
  const params = {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string", description: "Public id, e.g. fundingmap:1459" } },
  };
  const responses = {
    302: {
      description:
        "The stored link-out. `Location` is a URL from the record itself — never one supplied by the caller.",
      headers: {
        Location: { schema: { type: "string", format: "uri" }, description: "The destination." },
      },
    },
    404: { $ref: "ErrorResponse#" },
  };

  router.get(
    "/:id/apply",
    {
      // Bounded, because this route emits a `Location` and is the obvious thing to point a script
      // at if the goal is to inflate a publisher's apply count.
      //
      // THE TWO REDIRECTS STAY ADDRESS-KEYED, and stay on the declarative `config.rateLimit`. They
      // accept no credential — a link-out is followed by a browser that was never asked to sign in
      // — so there is no account to meter and nothing for `meteredAuth`'s resolve step to resolve.
      // The address is not a weaker key here, it is the only key there is; the credentialed routes
      // are the ones where keying by address would have been the wrong choice. Nothing is stored:
      // the key lives in an in-memory counter that expires with its window.
      config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
      schema: {
        operationId: "followApplicationLink",
        tags: ["opportunities"],
        summary: "Redirect to an entry's applicationUrl, counting the click",
        description:
          "302 to the record's stored `applicationUrl`. 404 when the entry is not publicly visible, carries no `applicationUrl`, or the stored value is not an http(s) URL.",
        params,
        response: responses,
      },
    },
    redirectController.apply,
  );

  router.get(
    "/:id/source",
    {
      config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
      schema: {
        operationId: "followSourceLink",
        tags: ["opportunities"],
        summary: "Redirect to an entry's website, counting the click",
        description:
          "302 to the record's stored `website`. The re-cut removed `source.url`, so the program's own site is what a source link-out means. 404 under the same conditions as the apply redirect.",
        params,
        response: responses,
      },
    },
    redirectController.source,
  );
};
