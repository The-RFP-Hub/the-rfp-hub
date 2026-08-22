import { handleOAuthUserInfo } from "better-auth/oauth2";
/**
 * THE TRIPWIRE for the one decision in this migration that a dependency could quietly change under
 * us: what happens when a second provider turns up holding an address somebody already signs in
 * with.
 *
 * Our answer is that it is the SAME PERSON. With one-time codes as the only other method, holding
 * an address means controlling the mailbox — so an OAuth provider asserting a verified address it
 * also controls is a second proof of the same thing, and joining them is right. That is a policy,
 * written out in `createAuth`, and its failure mode is silent: a library minor that started
 * creating a SECOND identity, or that stopped scoping accounts by issuer, would not break a build.
 * It would fork one person into two accounts, and the second one would arrive with no role, no
 * memberships and no history.
 *
 * So this file drives `handleOAuthUserInfo` — the function the OAuth callback itself calls, not a
 * re-implementation of it — and asserts the shape that results. Google never ships in these tests;
 * what ships is the linking rule, and this is the rule.
 *
 * Isolation tag: `M3LINK` / `m3link-*@rfphub.invalid`.
 */
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import type { Auth } from "../../src/auth/better-auth.js";
import { db, pool } from "../../src/db/client.js";
import { accounts, authAccount, authUser } from "../../src/db/schema.js";
import { bearer, seedIdentity, signIn, testAuth, testAuthConfig } from "../helpers/auth.js";
import { cleanupFixtures } from "../helpers/cleanup.js";
import { describeWithDb } from "./db-gate.js";

const EMAILS = {
  linked: "m3link-linked@rfphub.invalid",
  stranger: "m3link-stranger@rfphub.invalid",
};
const HANDLE = "m3link-linked";

const run = describeWithDb;

run("M3LINK linking a second provider", () => {
  let app: FastifyInstance;
  // `$context` is a PROPERTY holding a promise, not a method — the instance's own resolved context.
  let context: Awaited<Auth["$context"]>;

  beforeAll(async () => {
    const auth = await testAuth();
    app = await buildApp({ auth: { auth, config: testAuthConfig() } });
    await app.ready();
    context = await auth.$context;
    await cleanupFixtures({ handles: [HANDLE], emails: Object.values(EMAILS) });
  }, 60_000);

  afterAll(async () => {
    await cleanupFixtures({ handles: [HANDLE], emails: Object.values(EMAILS) });
    await app.close();
    await pool.end();
  }, 60_000);

  /**
   * The callback's own decision, driven directly.
   *
   * `handleOAuthUserInfo` is what `/api/auth/callback/:provider` calls once a provider has handed
   * back a profile; everything above it is the provider's redirect dance, which proves nothing
   * about us. The context it needs is the auth instance's own.
   */
  const arriveFromProvider = async (email: string, providerAccountId: string) =>
    handleOAuthUserInfo(
      { context } as Parameters<typeof handleOAuthUserInfo>[0],
      {
        userInfo: { id: providerAccountId, email, name: "Linked Person", emailVerified: true },
        account: {
          providerId: "google",
          accountId: providerAccountId,
          // SUPPLIED BY THE CALLER, not derived by the library — verified in
          // `dist/oauth2/link-account.mjs`, which reads `account.issuer` and never computes one.
          // `local:oauth:<provider>` is the shape the OAuth routes use; it is the scope that makes
          // `accountId` unique (see src/db/auth-schema.ts) and getting it wrong here would make
          // this test assert against a key nothing else writes.
          issuer: "local:oauth:google",
          scope: "openid email profile",
        },
      } as Parameters<typeof handleOAuthUserInfo>[1],
    );

  it("joins a provider account to the identity that already holds the address", async () => {
    // An established person: signed in by code, provisioned, and given a role that must survive.
    const established = await seedIdentity(EMAILS.linked, { handle: HANDLE, role: "reviewer" });

    // A one-time code is a VERIFICATION, not a provider account, so this identity holds none yet —
    // `auth_account` is exclusively the ledger of linked OAuth providers in this deployment. Stated
    // as an assertion because it is the baseline the next one is measured against.
    const beforeLink = await db
      .select()
      .from(authAccount)
      .where(eq(authAccount.userId, established.userId));
    expect(beforeLink).toHaveLength(0);

    const result = await arriveFromProvider(EMAILS.linked, "google-subject-1");
    expect(result.error, JSON.stringify(result)).toBeFalsy();
    // Not a registration: this address was already known.
    expect(result.isRegister).toBe(false);
    expect(result.data?.user?.id).toBe(established.userId);

    // ONE identity, whatever the number of ways in.
    const users = await db.select().from(authUser).where(eq(authUser.email, EMAILS.linked));
    expect(users).toHaveLength(1);

    // …and now exactly one, hanging off the identity that already existed rather than a new one.
    const linked = await db
      .select()
      .from(authAccount)
      .where(eq(authAccount.userId, established.userId));
    expect(linked).toHaveLength(1);
    expect(linked[0]?.providerId).toBe("google");
    expect(linked[0]?.issuer).toBe("local:oauth:google");

    // ONE application account, the same row as before, with its role intact. This is the assertion
    // that a fork would break: a second identity would provision a second `accounts` row on its
    // first request, and that row would be a submitter with none of this one's history.
    const appAccounts = await db
      .select()
      .from(accounts)
      .where(eq(accounts.authUserId, established.userId));
    expect(appAccounts).toHaveLength(1);
    expect(appAccounts[0]?.id).toBe(established.account.id);
    expect(appAccounts[0]?.globalRole).toBe("reviewer");
    expect(appAccounts[0]?.handle).toBe(HANDLE);

    // …and the session that existed before the link still resolves to the same account.
    const me = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: bearer(established.token),
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().accountId).toBe(established.account.id);
    expect(me.json().role).toBe("reviewer");
    expect(me.json().email).toBe(EMAILS.linked);
  }, 60_000);

  it("is idempotent — the same provider identity arriving twice links once", async () => {
    const before = await db
      .select()
      .from(authAccount)
      .where(
        and(
          eq(authAccount.issuer, "local:oauth:google"),
          eq(authAccount.accountId, "google-subject-1"),
        ),
      );
    await arriveFromProvider(EMAILS.linked, "google-subject-1");
    const after = await db
      .select()
      .from(authAccount)
      .where(
        and(
          eq(authAccount.issuer, "local:oauth:google"),
          eq(authAccount.accountId, "google-subject-1"),
        ),
      );
    // The `(issuer, accountId)` unique index is what makes this true rather than a race — see
    // src/db/auth-schema.ts, where its absence from the generator's draft is recorded.
    expect(after).toHaveLength(before.length);
  }, 60_000);

  it("keeps the linking policy exactly as configured", async () => {
    // The four options this rests on, read from the LIVE instance rather than from the source that
    // sets them: a library default change is exactly the drift this file exists to catch.
    expect(context.options.account?.accountLinking).toMatchObject({
      enabled: true,
      // Empty: nothing is linked on an unverified address. A provider added to this list would be
      // trusted to assert an address without proving it.
      trustedProviders: [],
      // The code path the library's own linking issues are about. We have no use for it.
      allowDifferentEmails: false,
      // A later provider does not get to rewrite the profile.
      updateUserInfoOnLink: false,
    });
    // The tripwire's other half: if `emailAndPassword` is ever enabled, implicit linking becomes a
    // different threat (linking against a password account, not against a mailbox proof) and
    // `disableImplicitLinking` has to be revisited. It is off, and this says so.
    // Read through a cast because the instance's own type does not even carry the key — we never
    // pass it, so TypeScript forbids it statically today. The runtime assertion is the half that
    // survives somebody adding it later.
    const options = context.options as { emailAndPassword?: { enabled?: boolean } };
    expect(options.emailAndPassword?.enabled ?? false).toBe(false);
  });

  it("provisions a NEW identity for an address nobody holds", async () => {
    const fresh = await arriveFromProvider(EMAILS.stranger, "google-subject-2");
    expect(fresh.error, JSON.stringify(fresh)).toBeFalsy();
    // A first arrival IS a registration — the linking rule is about collisions, not about refusing
    // people who have never been here.
    expect(fresh.isRegister).toBe(true);
    const users = await db.select().from(authUser).where(eq(authUser.email, EMAILS.stranger));
    expect(users).toHaveLength(1);
    expect(users[0]?.id).not.toBe((await signIn(EMAILS.linked)).userId);
  }, 60_000);
});
