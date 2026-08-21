import type { FastifyRequest } from "fastify";
import { principalOf } from "../../../plugins/auth.js";
import { InsightsService } from "../../services/insights/insights.service.js";
import {
  OpportunityMetaService,
  isPrivileged,
} from "../../services/opportunities/opportunity-meta.service.js";
import type { InsightsSeriesView, InsightsSummaryView } from "../../shared/api-views.js";
import { forbidden } from "../../shared/http-error.js";
import { handled, paramsOf, queryOf } from "../../shared/route-helpers.js";

const insights = new InsightsService();
const meta = new OpportunityMetaService();

export const insightsController = {
  forOpportunity: handled(async (request: FastifyRequest) => {
    const principal = principalOf(request);
    const { id } = paramsOf<{ id: string }>(request);
    const { days } = queryOf<{ days?: number }>(request);

    // `resolveForViewer` is the ONE visibility rule, and it 404s an entry this caller may not see —
    // so a stranger asking for a pending entry's numbers gets the same answer the detail route
    // gives. What is left to decide here is the narrower question: a PUBLIC entry is readable by
    // everyone, but its traffic is its publisher's business.
    const scope = await meta.resolveForViewer(id, principal);
    if (!isPrivileged(scope.row, principal)) {
      throw forbidden(
        "not_your_entry",
        "traffic for an entry is visible to its submitter, to a member of its namespace, and to reviewers.",
      );
    }
    return (await insights.forOpportunity(id, { days })) satisfies InsightsSeriesView;
  }),

  mySummary: handled(async (request: FastifyRequest) => {
    const principal = principalOf(request);
    const { days } = queryOf<{ days?: number }>(request);
    return (await insights.summaryForOwner(
      {
        accountId: principal.accountId,
        namespaces: principal.memberships.map((membership) => membership.slug),
      },
      { days },
    )) satisfies InsightsSummaryView;
  }),
};
