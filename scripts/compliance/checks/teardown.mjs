/**
 * Never selectable and never skipped: a write run appends it last, in a `finally`, so a run that
 * left rows in somebody's deployment cannot report green about it.
 */
import { teardownSubmission } from "../accept/submission-cycle.mjs";
import { cleanup } from "../cleanup.mjs";

export const meta = {
  key: "teardown",
  requires: [],
  needs: ["api", "credential", "reviewer"],
  writes: true,
  // Hygiene, not a completion criterion — so it carries no contract id in any profile.
  contract: { m3: null, m4: null },
};

export async function run(ctx) {
  // The m4 profile writes through MCP rather than the publisher API, so what it has to put back is
  // one entry it knows by id, not a namespace's worth of fixtures.
  if (ctx.milestone === "m4") return teardownSubmission(ctx.report, ctx, ctx.state);
  await cleanup(ctx.report, ctx, ctx.state);
}
