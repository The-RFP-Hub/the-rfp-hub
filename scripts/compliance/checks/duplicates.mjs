/**
 * Criterion 4 — **a near-duplicate submission surfaces the match to the submitter**.
 *
 * It submits the criterion-1 fixture again, reworded the way a second publisher would write it,
 * and expects the response to name the original.
 *
 * THREE OUTCOMES THAT ARE NOT FAILURES, and each reports SKIP with its own reason rather than
 * quietly passing or quietly failing:
 *
 *   - `duplicateCheck: "disabled"` — the deployment has no embedding provider configured. Nothing
 *     to check, and pretending otherwise would report a capability nobody enabled;
 *   - `duplicateCheck: "unavailable"` — the provider was configured but did not answer in time. The
 *     entry is queued for the backfill job, which is the designed behaviour;
 *   - the original is not `approved AND is_listed` — a submitter's ANSWER is restricted to the
 *     public set on purpose, so that a "suspected match" response can never disclose somebody
 *     else's pending or unlisted title. Detection still ran and still recorded the pair for a
 *     reviewer; there is simply nothing here the submitter is entitled to be shown.
 *
 * `duplicateCheck` is load-bearing precisely because of this: without it a client cannot tell
 * "none found" from "not checked".
 */
import { callJson } from "../client.mjs";
import { fixtureId, paraphraseOf } from "../fixtures.mjs";

export async function checkDuplicates(report, ctx, state) {
  const c = report.criterion(
    "duplicates",
    "Duplicate detection",
    "A reworded resubmission surfaces the original to the submitter, and reports honestly when detection did not run.",
  );

  if (!state.publishedId || !state.document || !state.writeToken) {
    c.skip("near-duplicate submission", "the lifecycle criterion produced no fixture to duplicate");
    return c.finish();
  }

  const id = fixtureId(ctx.namespace, state.run, "paraphrase");
  const created = await callJson(ctx, "/v1/opportunities", {
    method: "POST",
    token: state.writeToken,
    body: paraphraseOf(state.document, id),
  });

  if (!created.ok || created.status !== 201 || !created.json) {
    c.fail(
      "the reworded resubmission is accepted",
      created.ok ? `HTTP ${created.status}: ${created.body?.slice(0, 300)}` : created.error,
    );
    return c.finish();
  }
  state.fixtureIds.push(id);
  c.pass("the reworded resubmission is accepted", "201");

  const status = created.json.duplicateCheck;
  c.info("duplicateCheck", String(status));

  if (status === "disabled" || status === "unavailable") {
    c.skip(
      "the original is surfaced as a suspected match",
      status === "disabled"
        ? 'this deployment has no embedding provider configured, so detection did not run. `duplicateCheck: "disabled"` is the API telling the truth about that — the criterion cannot be established here.'
        : "the embedding provider did not answer within the timeout. The entry stays in the backfill job's predicate, which is the designed behaviour; the criterion cannot be established from this run.",
    );
    return c.finish();
  }

  if (!state.isPublic) {
    c.skip(
      "the original is surfaced as a suspected match",
      "the criterion-1 fixture landed pending, and a submitter's answer is deliberately restricted to approved and listed entries so a match response cannot disclose somebody else's unpublished title. The pair is still recorded for a reviewer. Run with a credential for a verified member of --namespace to exercise this.",
    );
    return c.finish();
  }

  const matches = created.json.duplicates ?? [];
  c.expect(
    matches.some((match) => match.id === state.publishedId),
    "the original is surfaced as a suspected match",
    `${matches.length} match(es); the original scored ${matches.find((m) => m.id === state.publishedId)?.similarity}`,
    `the original was not among ${matches.length} match(es): ${matches.map((m) => `${m.id}@${m.similarity}`).join(", ") || "(none)"}`,
  );

  // The same pair has to be reachable afterwards, or a submitter who closed the tab has lost it.
  const mine = await callJson(ctx, "/v1/me/duplicates", { token: ctx.credential });
  if (mine.ok && mine.status === 200 && Array.isArray(mine.json?.items)) {
    c.expect(
      mine.json.items.some((item) => item.id === state.publishedId || item.id === id),
      "the pair is retrievable later from /v1/me/duplicates",
      `${mine.json.items.length} suspected pair(s) for this account`,
      "the submission response named a match that the account's own duplicate list does not carry",
    );
  } else {
    c.fail(
      "the pair is retrievable later from /v1/me/duplicates",
      mine.ok ? `HTTP ${mine.status}` : mine.error,
    );
  }

  return c.finish();
}
