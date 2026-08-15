/**
 * Putting the deployment back.
 *
 * This checker WRITES — entries, a key, analytics events — so it owes a teardown, and the teardown
 * has to be honest about what it can and cannot undo:
 *
 *   - **Entries** are rejected and unlisted, not deleted. There is no delete endpoint, deliberately:
 *     a published id may already be in an export, a feed or somebody's bookmarks. A rejected,
 *     unlisted entry is off every public surface, which is what "cleaned up" can mean here.
 *     Rejecting requires a REVIEWER session; without one the fixtures are left and NAMED, so a
 *     reader knows exactly what is there rather than discovering it later.
 *   - **The minted key** is revoked with the session that minted it. Revocation is soft — audit rows
 *     point at keys — so it stops working and stays resolvable.
 *   - **Analytics events** for the fixture stay. They belong to an entry that is no longer public,
 *     they are pruned by the retention job in time, and there is no endpoint that deletes them.
 *
 * Cleanup runs even when criteria failed, and its own failures are reported rather than thrown: a
 * teardown that hid a real result would be worse than one that left a row behind.
 */
import { callJson } from "./client.mjs";

export async function cleanup(report, ctx, state) {
  const c = report.criterion(
    "M3-T",
    "Fixture teardown",
    "Entries this run created are taken off every public surface, and the credential it minted is revoked. A hygiene criterion rather than a completion criterion — reported at the same level on purpose, so a run that left rows behind in a deployment cannot be green.",
  );

  if (ctx.keepFixtures) {
    c.skip("teardown", `--keep-fixtures: leaving ${state.fixtureIds.length} entries in place`, {
      fixtures: state.fixtureIds,
    });
    return c.finish();
  }

  // ── the key ──────────────────────────────────────────────────────────────────
  if (state.mintedKeyId && ctx.privyToken) {
    const revoked = await callJson(ctx, `/v1/keys/${state.mintedKeyId}`, {
      method: "DELETE",
      token: ctx.privyToken,
    });
    c.expect(
      revoked.ok && (revoked.status === 200 || revoked.status === 204),
      "the minted key is revoked",
      `key ${state.mintedKeyId} revoked`,
      `DELETE /v1/keys/${state.mintedKeyId} answered ${revoked.status ?? revoked.error} — REVOKE IT BY HAND`,
    );
  } else if (state.mintedKeyId) {
    c.warn("the minted key is revoked", `key ${state.mintedKeyId} was minted and NOT revoked`);
  } else {
    c.skip("the minted key is revoked", "no key was minted");
  }

  // ── the entries ──────────────────────────────────────────────────────────────
  if (state.fixtureIds.length === 0) {
    c.skip("fixtures are taken off the public surface", "this run created none");
    return c.finish();
  }
  const reviewer = ctx.adminToken ?? (state.me?.canReview ? ctx.privyToken : undefined);
  if (!reviewer) {
    c.warn(
      "fixtures are taken off the public surface",
      `no reviewer credential, so ${state.fixtureIds.length} fixture(s) are LEFT IN PLACE and will need rejecting by hand. They are all prefixed \`m3check-\`:\n${state.fixtureIds.map((id) => `  ${id}`).join("\n")}`,
      { fixtures: state.fixtureIds },
    );
    return c.finish();
  }

  const left = [];
  for (const id of state.fixtureIds) {
    const rejected = await callJson(
      ctx,
      `/v1/review/opportunities/${encodeURIComponent(id)}/reject`,
      { method: "POST", token: reviewer, body: { reason: "compliance fixture" } },
    );
    if (!rejected.ok || rejected.status !== 200)
      left.push(`${id} (${rejected.status ?? rejected.error})`);
  }
  c.expect(
    left.length === 0,
    "fixtures are rejected and taken off the public surface",
    `${state.fixtureIds.length} fixture(s) rejected and unlisted`,
    `could not reject:\n${left.map((entry) => `  ${entry}`).join("\n")}`,
    { fixtures: state.fixtureIds },
  );

  return c.finish();
}
