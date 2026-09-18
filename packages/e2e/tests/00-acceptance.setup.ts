/**
 * The acceptance bar, and the only place identities are provisioned.
 *
 * This is a Playwright SETUP PROJECT: every other project declares `dependsOn: ["setup"]`, so it
 * runs first, its result is visible in the report, and a failure here stops the dependent projects
 * rather than letting forty specs fail one by one with the same cause.
 *
 * IT IS WHERE SIGNUP PROVISIONING IS ASSERTED. The first successful sign-in creates the identity, a
 * `submitter` account and its welcome email event, before any `/v1` request; the first `/v1/me` must
 * then resolve to that same account rather than create another.
 *
 * THE LADDER TEST THAT USED TO OPEN THIS FILE IS GONE. It recorded which rung a run had reached and
 * which criteria were therefore blocked, because identities came from a third-party tenant and how
 * much of the suite could execute depended on what somebody had provisioned there. Everything here
 * runs offline now, so there is no level to record and nothing to be blocked by.
 *
 * Order is load-bearing:
 *   1. a fresh database grants nothing (the re-scoped cross-run assertion)
 *   2. signup provisioning (account + welcome at sign-in, reused by the first request)
 *   3. the administrator the operator ceremony made, and the ceremony's idempotence
 *   4. every remaining identity's first request
 *   5. provisioning: organizations, memberships, verification — all through real routes
 */
import { dirname } from "node:path";
import { ceremonyLogFile, grantAdmin } from "../src/admin-ceremony.js";
import { DESKTOP_UA, expect, test } from "../src/fixtures.js";
import { ApiClient } from "../src/http.js";
import { ensureVerifiedPublisher, me } from "../src/identity/actors.js";
import { sessionFor } from "../src/identity/sessions.js";
import type { ActorName } from "../src/state.js";
import { updateState } from "../src/state.js";

/** Every part this run tries to fill, in the order their first logins are asserted. */
const ORDER: ActorName[] = ["submitter", "admin", "publisher", "otherPublisher", "reviewer"];

test.describe.configure({ mode: "serial" });

test("a fresh database grants nothing: no role survives a run", async ({ stack, db }) => {
  test.skip(
    !stack.previousAdminEmail,
    "not applicable: no earlier run recorded a different administrator. Set E2E_ASSIGNMENT_RECORD " +
      "and run twice with different E2E_ACTOR_SEED values to exercise it.",
  );
  const previous = stack.previousAdminEmail;
  if (!previous) return;

  // WHAT THIS ASSERTION IS, NOW, AND WHAT IT USED TO BE. It used to span two stores: identities
  // lived in an external tenant that outlived every run while the database did not, so comparing
  // runs proved that an identity which had been an administrator came back with nothing — the
  // tenant remembered the person, the deployment had forgotten the privilege.
  //
  // The identity store IS this run's database now, destroyed with its container, so that comparison
  // no longer spans anything. Claiming it still did would be the report saying something it has not
  // established. What remains true, and worth pinning, is the weaker statement: a fresh database
  // grants nothing. No role survives a run; the rotation really does move the administrator between
  // addresses; and the ceremony is the only thing that creates one.
  expect(
    previous,
    "the rotation must have moved the administrator to a different address",
  ).not.toBe(stack.actors.admin?.email);

  // The previous run's administrator address exists nowhere in this database — not as an identity,
  // not as an account, and certainly not as a role.
  const identity = await db.query("SELECT id FROM auth_user WHERE email = $1", [
    previous.toLowerCase(),
  ]);
  expect(identity.rowCount, "an address from an earlier run has no identity row here").toBe(0);

  const admins = await db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM accounts WHERE global_role = 'admin'",
  );
  expect(
    admins.rows[0]?.n,
    "exactly one administrator exists, and the ceremony is what made it",
  ).toBe(1);
});

test("M5 signup provisioning: sign-in creates a submitter account and a welcome, the first request reuses it", async ({
  stack,
  db,
}) => {
  const actor = ([stack.actors.submitter, stack.actors.publisher] as const).find(
    (candidate) => candidate && candidate.userId !== stack.browserUserId,
  );
  test.skip(!actor, "BLOCKED: no non-administrator identity outside the browser session.");
  if (!actor) return;

  const before = await db.query<{ id: number; global_role: string }>(
    "SELECT id, global_role FROM accounts WHERE auth_user_id = $1",
    [actor.userId],
  );
  expect(before.rowCount, `sign-in provisioned exactly one account for ${actor.email}`).toBe(1);
  expect(before.rows[0]?.global_role).toBe("submitter");
  const accountId = Number(before.rows[0]?.id);

  const welcome = await db.query(
    "SELECT id FROM notifications WHERE account_id = $1 AND kind = 'welcome'",
    [accountId],
  );
  expect(welcome.rowCount, "signup recorded exactly one welcome email event").toBe(1);

  const { token } = await sessionFor(actor.email);
  const client = new ApiClient({ baseUrl: stack.urls.api, token, userAgent: DESKTOP_UA });
  const view = await me(client);

  expect(view.accountId).toBe(accountId);
  expect(view.role).toBe("submitter");
  expect(view.credentialKind).toBe("session");
  expect(view.canAdmin).toBe(false);
  expect(view.canReview).toBe(false);
  expect(view.canManageKeys).toBe(true);
  expect(view.memberships).toEqual([]);

  const after = await db.query("SELECT id FROM accounts WHERE auth_user_id = $1", [actor.userId]);
  expect(after.rowCount, "the first request created no second account").toBe(1);

  updateState((state) => {
    const target = ([state.actors.submitter, state.actors.publisher] as const).find(
      (candidate) => candidate && candidate.userId === actor.userId,
    );
    if (target) {
      target.accountId = view.accountId;
      target.handle = view.handle;
    }
  });
});

test("M3-1 the operator ceremony made this run's administrator, and is idempotent", async ({
  stack,
  db,
}) => {
  const actor = stack.actors.admin;
  test.skip(!actor, "BLOCKED: no identity was established to be made administrator.");
  if (!actor) return;

  // THE ADMINISTRATOR IS NOT CONFIGURED, IT IS GRANTED. The API no longer promotes anyone named in
  // its environment; bring-up ran the shipped `grant-admin` ceremony against the migration
  // credential. What is asserted here is the whole of that contract: the effect on the account, and
  // the audit row that makes the grant an accountable event rather than a silent standing rule.
  expect(stack.adminCeremony, "bring-up performed the ceremony on a fresh database").toBe(
    "granted",
  );

  const client = new ApiClient({
    baseUrl: stack.urls.api,
    token: (await sessionFor(actor.email)).token,
    userAgent: DESKTOP_UA,
  });
  const view = await me(client);

  expect(view.role).toBe("admin");
  expect(view.canAdmin).toBe(true);
  // `requireRole("reviewer")` admits administrators, which is what lets a small identity count
  // cover the reviewer surface without spending a scarce non-admin actor on it.
  expect(view.canReview).toBe(true);

  // The audited event. `actor_kind: "job"` because no person acted through the product — an operator
  // acted on the database — and the reason names the ceremony so the row cannot be confused with an
  // ordinary administrator promoting a colleague over `POST /v1/admin/accounts/:id/role`.
  const audited = await db.query<{ actor_kind: string; patch: Record<string, unknown> }>(
    `SELECT a.actor_kind, a.patch FROM audit_log a
      WHERE a.subject_kind = 'account' AND a.subject_id = $1 AND a.action = 'assign_role'`,
    [view.accountId],
  );
  expect(audited.rowCount, "the grant is recorded exactly once").toBe(1);
  expect(audited.rows[0]?.actor_kind).toBe("job");
  expect(audited.rows[0]?.patch).toMatchObject({
    reason: "operator_grant_admin",
    globalRole: { after: "admin" },
  });

  // IDEMPOTENCE, pinned. Re-running the ceremony is the ordinary thing an operator does after an
  // interrupted install, and it must neither fail nor write a second grant into the trail.
  const repeat = await grantAdmin({
    email: actor.email,
    adminDatabaseUrl: stack.db.adminUrl,
    logFile: ceremonyLogFile(dirname(stack.logs.api ?? "."), "acceptance-repeat"),
  });
  expect(repeat.outcome, "a repeat grant reports the account was already an administrator").toBe(
    "unchanged",
  );
  expect(repeat.exitCode, "and a no-op is a success").toBe(0);

  const afterRepeat = await db.query(
    `SELECT 1 FROM audit_log a
      WHERE a.subject_kind = 'account' AND a.subject_id = $1 AND a.action = 'assign_role'`,
    [view.accountId],
  );
  expect(afterRepeat.rowCount, "a no-op writes no second audit row").toBe(1);

  updateState((state) => {
    if (state.actors.admin) {
      state.actors.admin.accountId = view.accountId;
      state.actors.admin.handle = view.handle;
    }
    if (state.actors.reviewer) {
      state.actors.reviewer.accountId = view.accountId;
      state.actors.reviewer.handle = view.handle;
    }
  });
});

test("ACCEPTANCE: every provisioned identity's token is accepted by the API", async ({
  stack,
  db,
}) => {
  const present = ORDER.filter((name) => stack.actors[name]);
  test.skip(
    present.length === 0,
    "BLOCKED: no identity was established, so the acceptance bar — that a session obtained by " +
      "signing in is accepted by this API — cannot be executed.",
  );

  const seen = new Set<string>();
  for (const name of present) {
    const actor = stack.actors[name];
    if (!actor || seen.has(actor.userId)) continue;
    seen.add(actor.userId);

    const client = new ApiClient({
      baseUrl: stack.urls.api,
      token: (await sessionFor(actor.email)).token,
      userAgent: DESKTOP_UA,
    });
    const response = await client.get<{ accountId: number }>("/v1/me");
    expect(response.status, `${name} (${actor.email}) must be accepted`).toBe(200);

    const row = await db.query("SELECT id FROM accounts WHERE auth_user_id = $1", [actor.userId]);
    expect(row.rowCount, `${name}'s account exists after its first request`).toBe(1);

    updateState((state) => {
      const target = state.actors[name];
      if (target) target.accountId = response.body.accountId;
    });
  }
});

test("provisioning: organizations exist, memberships are granted, verification is recorded", async ({
  stack,
  db,
}) => {
  test.skip(
    !stack.actors.admin || !stack.actors.publisher,
    "BLOCKED: provisioning a verified publisher needs an administrator and at least one further " +
      "identity.",
  );
  if (!stack.actors.admin || !stack.actors.publisher) return;

  const clients = new Map<ActorName, ApiClient>();
  const clientFor = (actor: ActorName): ApiClient => {
    const client = clients.get(actor);
    if (!client) throw new Error(`no client prepared for ${actor}`);
    return client;
  };
  for (const name of ORDER) {
    const actor = stack.actors[name];
    if (!actor) continue;
    clients.set(
      name,
      new ApiClient({
        baseUrl: stack.urls.api,
        token: (await sessionFor(actor.email)).token,
        userAgent: DESKTOP_UA,
      }),
    );
  }

  const ctx = {
    clientFor,
    actors: stack.actors,
    namespaces: stack.namespaces,
    runId: stack.runId,
    applicationUrl: stack.urls.programme,
  };

  await ensureVerifiedPublisher(ctx, "publisher", stack.namespaces.publisher);
  if (stack.actors.otherPublisher) {
    await ensureVerifiedPublisher(ctx, "otherPublisher", stack.namespaces.other);
  }

  // The membership is read back through `/v1/me` rather than trusted from the grant's own response:
  // the criterion is that the account SEES itself as a verified publisher, which is what every
  // capability decision downstream is made from.
  const view = await me(clientFor("publisher"));
  expect(view.memberships).toContainEqual(
    expect.objectContaining({ slug: stack.namespaces.publisher, verified: true }),
  );

  // The public directory is the other half: verification is only meaningful if it is visible.
  const publishers = await new ApiClient({ baseUrl: stack.urls.api }).get<{
    items: Array<{ slug: string }>;
  }>("/v1/publishers");
  expect(publishers.status).toBe(200);
  expect(publishers.body.items.map((item) => item.slug)).toContain(stack.namespaces.publisher);

  updateState((state) => {
    for (const name of ORDER) {
      const source = stack.actors[name];
      const target = state.actors[name];
      if (source && target) {
        target.accountId = source.accountId ?? target.accountId;
        target.namespace = source.namespace ?? target.namespace;
        target.verified = source.verified ?? target.verified;
      }
    }
  });

  // ── idempotence ────────────────────────────────────────────────────────────────────────────────
  //
  // Provisioning is re-run, in full, against the live stack. Re-running it is a supported path: a
  // reused `E2E_RUN_ID` is how one debugs against a part-provisioned stack, and every step here is
  // either create-only at the API (the organization stub) or an upsert (membership, verification).
  //
  // Re-invoking the RUNNER with the same `E2E_RUN_ID` is deliberately refused instead — its
  // workspace is created exclusively, because two live runs sharing one directory ended with the
  // second deleting the first's session state. So the supported re-entry is this one: the same
  // provisioning, against the same stack, twice.
  const countsBefore = await counts(db, stack);

  await ensureVerifiedPublisher(ctx, "publisher", stack.namespaces.publisher);
  if (stack.actors.otherPublisher) {
    await ensureVerifiedPublisher(ctx, "otherPublisher", stack.namespaces.other);
  }

  const countsAfter = await counts(db, stack);
  expect(countsAfter, "re-provisioning must create nothing new").toEqual(countsBefore);

  // …and resolve every actor to exactly the same account it did the first time.
  const resolved = await me(clientFor("publisher"));
  expect(resolved.accountId).toBe(view.accountId);
  expect(resolved.memberships).toContainEqual(
    expect.objectContaining({ slug: stack.namespaces.publisher, verified: true }),
  );
});

/** Accounts, organizations and memberships this run owns — the things a second pass must not duplicate. */
async function counts(
  db: import("pg").Pool,
  stack: { runId: string; namespaces: { publisher: string; other: string } },
): Promise<Record<string, number>> {
  const slugs = [stack.namespaces.publisher, stack.namespaces.other];
  const organizations = await db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM organizations WHERE slug = ANY($1)",
    [slugs],
  );
  const memberships = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM org_memberships m
       JOIN organizations o ON o.id = m.organization_id WHERE o.slug = ANY($1)`,
    [slugs],
  );
  const accounts = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM accounts");
  return {
    organizations: organizations.rows[0]?.n ?? -1,
    memberships: memberships.rows[0]?.n ?? -1,
    accounts: accounts.rows[0]?.n ?? -1,
  };
}
