/**
 * Criterion 2 — **out-of-namespace submissions land in the review queue**.
 *
 * The same credential that publishes instantly into its own namespace must be an ordinary submitter
 * everywhere else. This submits into a namespace the credential demonstrably does not hold and
 * checks three things, because "it was queued" is only half the property:
 *
 *   1. the submission is ACCEPTED — a submitter who cannot publish still wants their entry
 *      recorded, so this fails closed to `pending` rather than to an error;
 *   2. it lands `pending`;
 *   3. it is INVISIBLE on the public read surface until somebody approves it. A queue that anyone
 *      can read is not a queue, and the read invariant is the whole basis of the public dataset.
 */
import { callJson } from "../client.mjs";
import { fixtureDocument, fixtureId } from "../fixtures.mjs";

export async function checkNamespace(report, ctx, state) {
  const c = report.criterion(
    "namespace",
    "Namespace review queue",
    "A submission into a namespace the credential does not hold is accepted, lands pending, and is not publicly readable.",
  );

  if (!state.writeToken) {
    c.skip("out-of-namespace submission", "the lifecycle criterion produced no write credential");
    return c.finish();
  }

  // A namespace nobody holds, derived from the fixture namespace so it is recognisable in a
  // directory listing later and cannot collide with a real organisation's slug.
  const foreign = `${ctx.namespace}-compliance-foreign`;
  const id = fixtureId(foreign, state.run, "foreign");
  const document = fixtureDocument({
    id,
    namespace: foreign,
    title: `M3 compliance out-of-namespace fixture ${state.run}`,
  });

  const created = await callJson(ctx, "/v1/opportunities", {
    method: "POST",
    token: state.writeToken,
    body: document,
  });

  if (!created.ok || created.status !== 201 || !created.json) {
    c.fail(
      "an out-of-namespace submission is accepted rather than refused",
      created.ok
        ? `HTTP ${created.status}: ${created.body?.slice(0, 300)}`
        : `transport: ${created.error}`,
    );
    return c.finish();
  }
  state.fixtureIds.push(id);
  state.foreignId = id;
  c.pass("an out-of-namespace submission is accepted rather than refused", "201");

  c.expect(
    created.json.reviewStatus === "pending",
    "it lands in the review queue",
    "reviewStatus pending",
    `reviewStatus ${created.json.reviewStatus} — a credential that does not hold this namespace must not publish into it`,
  );

  const publicRead = await callJson(ctx, `/v1/opportunities/${encodeURIComponent(id)}`);
  c.expect(
    publicRead.status === 404,
    "a queued entry is not on the public read surface",
    "GET /v1/opportunities/{id} → 404",
    `answered ${publicRead.status ?? publicRead.error} — an unapproved entry must not be readable`,
  );

  const list = await callJson(ctx, "/v1/opportunities?limit=100&q=compliance", {});
  if (list.ok && list.status === 200 && Array.isArray(list.json?.items)) {
    c.expect(
      !list.json.items.some((item) => item.id === id),
      "a queued entry is not in the public list",
      "absent from a search that would otherwise surface it",
      "the public list returned an entry that has not been approved",
    );
  } else {
    c.skip("a queued entry is not in the public list", `list query answered ${list.status}`);
  }

  // The owner can still see their own queued entry — otherwise a submitter has no way to know what
  // happened to it, and the queue becomes a place submissions disappear into.
  const owned = await callJson(ctx, `/v1/me/opportunities/${encodeURIComponent(id)}`, {
    token: ctx.credential,
  });
  c.expect(
    owned.ok && owned.status === 200,
    "the submitter can still read their own queued entry",
    "GET /v1/me/opportunities/{id} → 200",
    `answered ${owned.status ?? owned.error}`,
  );

  return c.finish();
}
