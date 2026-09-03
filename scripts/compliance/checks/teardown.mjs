/**
 * Never selectable and never skipped: a write run appends it last, in a `finally`, so a run that
 * left rows in somebody's deployment cannot report green about it.
 */
import { cleanup } from "../cleanup.mjs";

export const meta = {
  key: "teardown",
  requires: [],
  needs: ["api", "namespace", "credential", "reviewer"],
  writes: true,
  // Hygiene, not a completion criterion — so it carries no contract id in any profile.
  contract: { m3: null, m4: null },
};

export async function run(ctx) {
  await cleanup(ctx.report, ctx, ctx.state);
}
