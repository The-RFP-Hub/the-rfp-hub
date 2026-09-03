/**
 * Criterion 3 — **the audit trail is visible for any entry, and carries every mutation with its
 * timestamp**.
 *
 * Two readers, two answers, and both have to be right for the criterion to mean anything:
 *
 *   - the PUBLIC sees the action, the time, a coarse actor and the changed field NAMES. Not the
 *     values: a pending entry's contents are not public and neither is a publisher's contact;
 *   - the OWNER (and a reviewer) additionally sees the full `{field: {before, after}}` patch.
 *
 * So this asserts the shape of both AND the difference between them. A trail that leaked the patch
 * to everyone would satisfy "visible" and fail the design; one that showed the owner no more than
 * the public would satisfy the design and be useless.
 */
import { callJson } from "../client.mjs";

export async function checkAudit(report, ctx, state) {
  const c = report.criterion(
    "audit",
    "Audit trail",
    "Every mutation of an entry is recorded with its action, actor and timestamp; the public view is redacted and the owner's is not.",
  );

  const id = state.publishedId;
  if (!id) {
    c.unmet("audit trail", "the lifecycle criterion did not create a fixture to have a history");
    return c.finish();
  }
  const path = `/v1/opportunities/${encodeURIComponent(id)}/audit`;

  // ── the owner's view ─────────────────────────────────────────────────────────
  const owner = await callJson(ctx, path, { token: ctx.credential });
  if (!owner.ok || owner.status !== 200 || !Array.isArray(owner.json?.entries)) {
    c.fail(
      "the entry's own submitter can read its trail",
      owner.ok ? `HTTP ${owner.status}: ${owner.body?.slice(0, 200)}` : owner.error,
    );
    return c.finish();
  }
  const entries = owner.json.entries;
  c.pass("the entry's own submitter can read its trail", `${entries.length} entries`);

  const actions = entries.map((entry) => entry.action);
  c.expect(
    actions.includes("create"),
    "the create is recorded",
    "a `create` row is present",
    `actions recorded: ${actions.join(", ") || "(none)"}`,
  );
  if (state.updated) {
    c.expect(
      actions.includes("update"),
      "the update is recorded",
      "an `update` row is present",
      `the PUT succeeded but no \`update\` row followed it — actions: ${actions.join(", ")}`,
    );
  } else {
    c.skip("the update is recorded", "the PUT in the lifecycle criterion did not succeed");
  }

  c.expect(
    entries.every((entry) => typeof entry.at === "string" && !Number.isNaN(Date.parse(entry.at))),
    "every row carries a parseable timestamp",
    "all `at` values parse",
    `rows without a usable timestamp: ${entries.filter((e) => Number.isNaN(Date.parse(e.at))).length}`,
  );
  c.expect(
    entries.every((entry) => typeof entry.actorKind === "string" && entry.actorKind !== ""),
    "every row names what kind of actor made the change",
    `actor kinds: ${[...new Set(entries.map((e) => e.actorKind))].join(", ")}`,
    "a row carried no `actorKind`",
  );
  c.expect(
    entries.some((entry) => entry.patch !== undefined),
    "the owner sees the full before/after patch",
    "at least one row carries `patch`",
    "no row carried a patch — the owner's view is not distinguishable from the public one",
  );

  // ── the public view ──────────────────────────────────────────────────────────
  const anonymous = await callJson(ctx, path);
  if (state.isPublic) {
    if (anonymous.ok && anonymous.status === 200 && Array.isArray(anonymous.json?.entries)) {
      c.pass("the trail of a public entry is publicly readable", "HTTP 200");
      c.expect(
        anonymous.json.entries.every((entry) => entry.patch === undefined),
        "the public view is redacted to field NAMES",
        "no row carries a patch",
        "a patch reached an unauthenticated reader — a pending entry's values and a publisher's contact are not public",
      );
      c.expect(
        anonymous.json.entries.every((entry) => Array.isArray(entry.changedFields)),
        "the public view still names which fields changed",
        "every row carries `changedFields`",
        "a public row carried no `changedFields`, so the trail says nothing useful",
      );
    } else {
      c.fail(
        "the trail of a public entry is publicly readable",
        anonymous.ok ? `HTTP ${anonymous.status}` : anonymous.error,
      );
    }
  } else {
    c.expect(
      anonymous.status === 404,
      "the trail of a non-public entry 404s for everyone else",
      "404, matching the detail route",
      `answered ${anonymous.status ?? anonymous.error} — a trail must not be a side channel onto an entry the detail route hides`,
    );
  }

  return c.finish();
}

export const meta = {
  key: "audit",
  requires: [{ key: "lifecycle", hard: true }],
  needs: ["api", "namespace", "credential"],
  writes: true,
  contract: { m3: "M3-3" },
};

export async function run(ctx) {
  await checkAudit(ctx.report, ctx, ctx.state);
}
