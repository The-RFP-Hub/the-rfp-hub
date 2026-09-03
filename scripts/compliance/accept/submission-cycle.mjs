/**
 * The real 3-phase MCP submission interlock, as a write criterion. `checks/mcp.mjs` proves phase 1
 * writes nothing, against a local recording server; this drives the whole cycle against a writable
 * staging deployment, and it is the reason this profile lives behind the target guard.
 *
 * Teardown is a SEPARATE criterion (`checks/teardown.mjs` delegates to `teardownSubmission` below),
 * not a check inside this one: a criterion is only SKIP when every check in it is skipped, so a
 * `--keep-fixtures` run would still have been green on the strength of the submission checks.
 */
import { runSubmissionCycle, teardown, verifyLandedPending, verifyTornDown } from "./flow.mjs";

export const meta = {
  key: "submission-cycle",
  requires: [],
  needs: ["api", "repoRoot", "credential", "reviewer"],
  writes: true,
  contract: { m4: "M4-ACCEPT" },
};

export async function run(ctx) {
  const { report, state } = ctx;
  const c = report.criterion(
    "submission-cycle",
    "Real 3-phase MCP submission interlock",
    "preview → out-of-band approval → commit lands a fixture pending, verified via /v1/me/opportunities. The approval is DRIVEN unless --interactive-approval is passed; the report says which.",
  );

  try {
    const opportunityId = await runSubmissionCycle(ctx, state, c);

    const entry = await verifyLandedPending(ctx, opportunityId);
    c.expect(
      entry.reviewStatus === "pending",
      "the fixture landed pending, verified via GET /v1/me/opportunities",
      `reviewStatus=${entry.reviewStatus}`,
      `reviewStatus=${entry.reviewStatus}, expected "pending"`,
    );
  } catch (err) {
    // Once `commitAttempted` is true, a throw does NOT mean "nothing was created": the POST may
    // have reached the API unseen. The candidate id — the document's own — lets teardown find it.
    if (state.commitAttempted && state.candidateOpportunityId) {
      c.fail(
        "preview → out-of-band approval → commit completes",
        `${err.message} — the outcome is AMBIGUOUS (the POST may have reached the API even though this call did not return); checking /v1/me/opportunities for ${state.candidateOpportunityId}`,
      );
      try {
        const entry = await verifyLandedPending(ctx, state.candidateOpportunityId);
        state.opportunityId = state.candidateOpportunityId;
        c.warn(
          "ambiguous commit actually landed",
          `${state.candidateOpportunityId} is present with reviewStatus=${entry.reviewStatus} despite the error above — tearing it down`,
        );
      } catch (verifyErr) {
        c.info(
          "ambiguous commit verification",
          `${state.candidateOpportunityId} not found via /v1/me/opportunities either (${verifyErr.message}) — most likely the write genuinely did not land, but this is not certain`,
        );
      }
    } else {
      c.fail("preview → out-of-band approval → commit completes", err.message);
    }
  } finally {
    c.info("approval mode", state.approvalMode ?? "(never reached)");
    c.finish();
  }
}

/** Putting the one entry this profile submits back, and proving it is off every reader's surface. */
export async function teardownSubmission(report, ctx, state) {
  const c = report.criterion(
    "teardown",
    "Fixture teardown",
    "The fixture this run created is rejected and unlisted, then verified gone from the owner listing and the public route. A hygiene criterion, reported at the same level as the submission cycle on purpose, so --keep-fixtures cannot be green.",
  );

  if (ctx.keepFixtures) {
    c.unmet(
      "teardown",
      `--keep-fixtures: leaving ${state.opportunityId ?? "(nothing created)"} in place`,
      { fixtures: state.opportunityId ? [state.opportunityId] : [] },
    );
    return c.finish();
  }
  if (!state.opportunityId) {
    c.skip("teardown", "no fixture was created — nothing to tear down");
    return c.finish();
  }

  try {
    await teardown(ctx, state.opportunityId);
    // A 200 from the reject endpoint is not the same fact as "the entry is gone from every
    // surface a reader can reach", which is what teardown is for.
    const gone = await verifyTornDown(ctx, state.opportunityId);
    c.expect(
      gone.ok,
      "teardown",
      `${state.opportunityId} rejected; owner listing shows ${gone.ownerStatus} and the public route answers ${gone.publicStatus}`,
      `${state.opportunityId} was rejected but is still reachable: owner listing shows ${gone.ownerStatus}, the public route answers ${gone.publicStatus} — REJECT/UNLIST IT BY HAND`,
    );
  } catch (err) {
    // A teardown failure leaves a real entry behind in the deployment this tool just wrote to.
    // That is a FAILED run, not a warning on an otherwise-green one.
    c.fail("teardown", err.message);
  }

  return c.finish();
}
