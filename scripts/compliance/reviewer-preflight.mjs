/**
 * Proving the teardown credential BEFORE the first write.
 *
 * Presence is not capability. `--session-token` with no `--admin-token` used to be assumed to name
 * a reviewer, so a plain publisher session passed every refusal, wrote four fixtures, and only then
 * discovered at teardown that it could not reject any of them — leaving rows on the public surface
 * of somebody's deployment. An expired or demoted `--admin-token` failed the same way.
 *
 * So the capability is read off the deployment, over one request, before anything is created —
 * including for the m4 profile, whose whole cycle writes through the MCP server and whose teardown
 * rejects the entry it submitted.
 */
import { callJson } from "./client.mjs";

/**
 * The credential the teardown will actually use — the same precedence `cleanup.mjs` applies, and
 * the same one for every profile: an `--admin-token` names the reviewer, and a `--session-token`
 * stands in when that account may review on its own.
 */
export function reviewerCredential(opts) {
  return opts.adminToken
    ? { token: opts.adminToken, flag: "--admin-token" }
    : { token: opts.sessionToken, flag: "--session-token" };
}

const TEARDOWN_WHY =
  "the teardown rejects and unlists everything this run creates, and a run that cannot tear down must not start";

/** Why this run must not write, or `null` when its teardown credential may review. */
export async function reviewerRefusal(ctx, opts) {
  const { token, flag } = reviewerCredential(opts);
  const me = await callJson(ctx, "/v1/me", { token });
  if (!me.ok) {
    return `${flag} could not be checked against ${ctx.api}/v1/me — ${me.error}`;
  }
  if (me.status !== 200) {
    return `${flag} was answered ${me.status} by ${ctx.api}/v1/me, so its capabilities cannot be established — ${TEARDOWN_WHY}`;
  }
  if (me.json?.canReview !== true) {
    return `${flag} names an account that may not review (\`canReview\` is ${JSON.stringify(me.json?.canReview)} at ${ctx.api}/v1/me) — ${TEARDOWN_WHY}. Pass an --admin-token whose account may review.`;
  }
  return null;
}
