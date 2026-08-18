/**
 * The acceptance bar, and the only place identities are provisioned.
 *
 * This is a Playwright SETUP PROJECT: every other project declares `dependsOn: ["setup"]`, so it
 * runs first, its result is visible in the report, and a failure here stops the dependent projects
 * rather than letting forty specs fail one by one with the same cause.
 *
 * IT IS ALSO WHERE THE JUST-IN-TIME PROVISIONING CRITERION IS ASSERTED, and that is why the
 * preflight makes no call to this API. The very first `/v1/me` a fresh identity ever sends is the
 * assertion: an account must not exist before it, and must exist as a `submitter` after it. A
 * bring-up step that had "checked the token works" would have consumed that observation, and the
 * criterion could then only be claimed, never shown.
 *
 * Order is load-bearing:
 *   1. the ladder level and its blocked list are recorded — this runs at EVERY level, including the
 *      one where nothing else can, so a degraded run still produces executed evidence
 *   2. the plain submitter's first login (fresh account, `submitter`)
 *   3. the administrator the operator ceremony made (`admin`, `canAdmin`, the audited grant, and
 *      the ceremony's idempotence)
 *   4. every remaining identity's first login
 *   5. provisioning: organisations, memberships, verification — all through real routes
 */
import { dirname } from "node:path";
import { ceremonyLogFile, grantAdmin } from "../src/admin-ceremony.js";
import { DESKTOP_UA, expect, test } from "../src/fixtures.js";
import { ApiClient } from "../src/http.js";
import { ensureVerifiedPublisher, me } from "../src/privy/identities.js";
import type { ActorName } from "../src/state.js";
import { updateState } from "../src/state.js";
import { tokenForDid } from "../src/tokens.js";

/** Every part this run tries to fill, in the order their first logins are asserted. */
const ORDER: ActorName[] = ["submitter", "admin", "publisher", "otherPublisher", "reviewer"];

test.describe.configure({ mode: "serial" });

test("the ladder level and every blocked criterion are recorded", async ({ stack }) => {
  expect(
    ["L0-FULL", "L1-REDUCED-IDENTITY", "L2-API-ONLY", "L3-BROWSER-ONLY", "L4-NO-PRIVY"],
    "the runner must classify the run into a known level",
  ).toContain(stack.level);

  if (stack.level === "L4-NO-PRIVY") {
    // The degraded level is a REPORTED state, not a silent one. Everything real-auth is blocked,
    // and each blocked entry has to name the configuration that would unblock it — a run that said
    // only "skipped" would be indistinguishable from a run that had nothing to test.
    expect(
      stack.blocked.length,
      "the no-identity level must declare what it cannot reach",
    ).toBeGreaterThan(0);
    for (const entry of stack.blocked) {
      expect(
        entry.unblockedBy.length,
        `"${entry.area}" must name what would unblock it`,
      ).toBeGreaterThan(0);
    }
    expect(stack.preflight.tenantAcknowledged || stack.preflight.identities === 0).toBe(true);
  }

  // The stack itself is up at every level, which is what makes the negative-authentication surface
  // and the least-privilege boot testable even with no identity at all.
  const health = await new ApiClient({ baseUrl: stack.urls.api }).get<{
    status: string;
    db: string;
  }>("/v1/health");
  expect(health.status).toBe(200);
  expect(health.body).toMatchObject({ status: "ok", db: "up" });
});

test("cross-run: an identity that was an administrator returns with no privileges", async ({
  stack,
  db,
}) => {
  test.skip(
    !stack.previousAdminDid,
    "not applicable: no earlier run recorded a DIFFERENT bootstrap administrator. " +
      "Set E2E_ASSIGNMENT_RECORD and run twice with different E2E_ACTOR_SEED values to exercise it.",
  );
  const did = stack.previousAdminDid;
  if (!did) return;

  // WHY THIS IS WORTH AN ASSERTION. The database is destroyed with its container, but the identity
  // tenant's users are not — they outlive every run. So "administrator" has to be something this
  // run grants, never something the identity carries. If the bootstrap list were too wide, or a
  // membership outlived the organisation it belonged to, this is where it would show.
  //
  // It runs BEFORE this run's provisioning, so nothing it observes can have been granted by this run.
  expect(did, "the rotation must have moved the administrator to a different identity").not.toBe(
    stack.actors.admin?.did,
  );

  const client = new ApiClient({
    baseUrl: stack.urls.api,
    token: await tokenForDid(did),
    userAgent: DESKTOP_UA,
  });
  const view = await me(client);

  expect(view.role, "an identity's privileges do not survive the run that granted them").toBe(
    "submitter",
  );
  expect(view.canAdmin).toBe(false);
  expect(view.canReview).toBe(false);
  expect(view.memberships, "no organisation membership may carry over either").toEqual([]);

  // And in the database it holds nothing beyond a bare account row.
  const rows = await db.query<{ global_role: string }>(
    "SELECT global_role FROM accounts WHERE privy_did = $1",
    [did],
  );
  expect(rows.rowCount).toBe(1);
  expect(rows.rows[0]?.global_role).toBe("submitter");

  const memberships = await db.query(
    "SELECT 1 FROM org_memberships m JOIN accounts a ON a.id = m.account_id WHERE a.privy_did = $1",
    [did],
  );
  expect(memberships.rowCount, "no membership row may exist for it").toBe(0);
});

test("M3-1 just-in-time provisioning: a fresh identity's first request creates a submitter account", async ({
  stack,
  db,
}) => {
  // The candidate must be an identity NOTHING has spoken to yet.
  //
  // The browser identity is disqualified by construction: bring-up signs it in, and the dashboard
  // issues `/v1/me` as soon as the session restores — so by the time this test runs, its account
  // already exists and the "did not exist beforehand" assertion could only ever fail. That is not a
  // product defect, it is this criterion being unobservable for that identity, and the honest
  // response is to use a different one or report the criterion blocked.
  const untouched = ([stack.actors.submitter, stack.actors.publisher] as const).find(
    (candidate) => candidate && candidate.did !== stack.browserDid,
  );
  test.skip(
    !untouched,
    "BLOCKED-by-missing-external-config: every available non-administrator identity has already " +
      "signed in through the browser during bring-up, so no first-ever request is left to observe. " +
      "Unblocked by: E2E_PRIVY_TEST_EMAILS (a further distinct test account that the browser does not use).",
  );
  const actor = untouched;
  if (!actor) return;

  // The account must not exist BEFORE the first request. Asserted against the database rather than
  // inferred from the response, because the response cannot distinguish "created just now" from
  // "existed already" — and that distinction is the whole criterion.
  const before = await db.query("SELECT id FROM accounts WHERE privy_did = $1", [actor.did]);
  expect(before.rowCount, `no account may exist for ${actor.did} before its first request`).toBe(0);

  const token = await tokenForDid(actor.did);
  const client = new ApiClient({ baseUrl: stack.urls.api, token, userAgent: DESKTOP_UA });
  const view = await me(client);

  expect(view.role).toBe("submitter");
  expect(view.credentialKind).toBe("session");
  expect(view.canAdmin).toBe(false);
  expect(view.canReview).toBe(false);
  // Any session can manage its own keys — a submitter included. This is the API's own answer and
  // the dashboard renders its navigation from it.
  expect(view.canManageKeys).toBe(true);
  expect(view.memberships).toEqual([]);

  const after = await db.query("SELECT id, global_role FROM accounts WHERE privy_did = $1", [
    actor.did,
  ]);
  expect(after.rowCount).toBe(1);
  expect(after.rows[0].global_role).toBe("submitter");

  updateState((state) => {
    const target = ([state.actors.submitter, state.actors.publisher] as const).find(
      (candidate) => candidate && candidate.did === actor.did,
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
  test.skip(
    !actor,
    "BLOCKED-by-missing-external-config: no identity is available to be made administrator. " +
      "Unblocked by: E2E_PRIVY_TENANT_ACK, E2E_PRIVY_TEST_EMAIL.",
  );
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
    token: await tokenForDid(actor.did),
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
    did: actor.did,
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
    "BLOCKED-by-missing-external-config: no legitimate access token could be obtained, so the " +
      "acceptance bar — that provider-issued tokens are accepted by this API — cannot be executed. " +
      "Unblocked by: E2E_PRIVY_TENANT_ACK, E2E_PRIVY_TEST_EMAIL, E2E_PRIVY_TEST_OTP.",
  );

  const seen = new Set<string>();
  for (const name of present) {
    const actor = stack.actors[name];
    if (!actor || seen.has(actor.did)) continue;
    seen.add(actor.did);

    const client = new ApiClient({
      baseUrl: stack.urls.api,
      token: await tokenForDid(actor.did),
      userAgent: DESKTOP_UA,
    });
    const response = await client.get<{ accountId: number }>("/v1/me");
    expect(response.status, `${name} (${actor.did}) must be accepted`).toBe(200);

    const row = await db.query("SELECT id FROM accounts WHERE privy_did = $1", [actor.did]);
    expect(row.rowCount, `${name}'s account exists after its first request`).toBe(1);

    updateState((state) => {
      const target = state.actors[name];
      if (target) target.accountId = response.body.accountId;
    });
  }
});

test("provisioning: organisations exist, memberships are granted, verification is recorded", async ({
  stack,
  db,
}) => {
  test.skip(
    !stack.actors.admin || !stack.actors.publisher,
    "BLOCKED-by-missing-external-config: provisioning a verified publisher needs an administrator " +
      "and at least one further identity. Unblocked by: E2E_PRIVY_TENANT_ACK, E2E_PRIVY_TEST_EMAILS.",
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
        token: await tokenForDid(actor.did),
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
  // either create-only at the API (the organisation stub) or an upsert (membership, verification).
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

/** Accounts, organisations and memberships this run owns — the things a second pass must not duplicate. */
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
