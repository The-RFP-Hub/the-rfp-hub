/**
 * `/v1/insights` — the publisher's own numbers.
 *
 * NOT PUBLIC, and not because the counts are sensitive: they are a publisher's operational feedback,
 * and a public leaderboard of what gets read would change what gets submitted. One entry's series is
 * visible to its submitter, to a member of its namespace and to T3; the summary is per-account by
 * construction.
 *
 * THERE IS NO PUBLIC BEACON, and its absence is a decision rather than an omission. An
 * unauthenticated `POST /v1/insights/events` lets anybody fabricate a publisher's numbers, and rate
 * limiting is not integrity — it bounds the forgery, it does not prevent it. All capture is
 * server-side and therefore unforgeable relative to this API. A beacon carrying short-lived signed
 * event tokens is the shape that could work, and it is recorded as M4.
 *
 * `/v1/stats` is untouched: that is the dataset's public shape, this is one account's traffic.
 */
import type { FastifyInstance } from "fastify";
import { insightsController } from "./insights.controller.js";

export const insights = async (router: FastifyInstance): Promise<void> => {
  const window = {
    days: {
      type: "integer",
      minimum: 1,
      maximum: 365,
      default: 30,
      description: "Length of the window, ending today (UTC).",
    },
  };
  const errors = {
    400: { $ref: "ErrorResponse#" },
    401: { $ref: "ErrorResponse#" },
    403: { $ref: "ErrorResponse#" },
    404: { $ref: "ErrorResponse#" },
  };

  router.get(
    "/opportunities/:id",
    {
      onRequest: router.auth.requireAuth,
      schema: {
        operationId: "getOpportunityInsights",
        tags: ["insights"],
        summary: "One entry's daily reads and link-outs",
        description:
          "Visible to the entry's submitter, to a member of its namespace, and to reviewers. BEST-EFFORT: these are API reads and link-outs rather than page views, our own automation and crawlers are excluded, `DNT: 1` is honoured, and capture is buffered in memory and so crash-lossy. Days before today come from the nightly rollup; today is aggregated live, so recent traffic is already visible.",
        security: [{ bearerAuth: [] }],
        params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
        querystring: { type: "object", additionalProperties: false, properties: window },
        response: { 200: { $ref: "InsightsSeries#" }, ...errors },
      },
    },
    insightsController.forOpportunity,
  );

  router.get(
    "/me/summary",
    {
      onRequest: router.auth.requireAuth,
      schema: {
        operationId: "getMyInsightsSummary",
        tags: ["insights"],
        summary: "Every entry this account submitted or publishes, totalled",
        description:
          "Same window and the same best-effort caveat as the per-entry series. Ownership is the same union the account's own listings use — submitted by this account, or published under a namespace it belongs to — so a publisher sees their organisation's entries even when a colleague filed them.",
        security: [{ bearerAuth: [] }],
        querystring: { type: "object", additionalProperties: false, properties: window },
        response: { 200: { $ref: "InsightsSummary#" }, ...errors },
      },
    },
    insightsController.mySummary,
  );
};
