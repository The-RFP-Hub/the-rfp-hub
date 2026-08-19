/**
 * The admin ceremony: the one grant the product cannot make, and the guard that keeps the product
 * from undoing it into a state only the ceremony can leave.
 *
 * The script is driven through its exported `main` rather than a subprocess: a spawned `tsx` would
 * assert the same behaviour twice as slowly, and what a test wants to read is what it PRINTED,
 * which a return value and a collected sink give directly.
 *
 * THE ADDRESS IS A LOOKUP, NOT A KEY. The script takes `--email` because that is what an operator
 * knows; what it stores is the subject behind it. So the interesting cases are the ones where the
 * two come apart: an address nobody has ever signed in as (a refusal that has to say what to do
 * about it), and `--subject` for when the operator already has the id.
 *
 * Isolation tag: `M3GRANT` / `m3grant-*@rfphub.invalid`.
 */
import { and, eq, ne } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";
import { main } from "../../scripts/grant-admin.js";
import { buildApp } from "../../src/app.js";
import { type DB, db, pool } from "../../src/db/client.js";
import { accounts, auditLog } from "../../src/db/schema.js";
import { AdminService } from "../../src/modules/services/admin/admin.service.js";
import { bearer, seedAccount, signIn, testAuth, testAuthConfig } from "../helpers/auth.js";
import { cleanupFixtures } from "../helpers/cleanup.js";
import { describeWithDb } from "./db-gate.js";

const EMAILS = {
  existing: "m3grant-existing@rfphub.invalid",
  fresh: "m3grant-fresh@rfphub.invalid",
  /** Deliberately never signed in: the address exists as a string and as nothing else. */
  absent: "m3grant-absent@rfphub.invalid",
  sole: "m3grant-sole@rfphub.invalid",
  second: "m3grant-second@rfphub.invalid",
};
const HANDLES = ["m3grant-existing", "m3grant-sole", "m3grant-second"];

const run = describeWithDb;

/** Run the script, collecting what it printed. */
async function grantAdmin(...argv: string[]): Promise<{ code: number; output: string }> {
  const lines: string[] = [];
  const code = await main(argv, (line) => lines.push(line));
  return { code, output: lines.join("\n") };
}

const accountFor = async (subject: string) =>
  (await db.select().from(accounts).where(eq(accounts.authUserId, subject)).limit(1))[0];

const roleGrants = async (accountId: number) =>
  (
    await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.subjectKind, "account"), eq(auditLog.subjectId, accountId)))
  ).filter((row) => row.action === "assign_role");

run("M3GRANT the admin ceremony", () => {
  let app: FastifyInstance;
  let existing: Awaited<ReturnType<typeof signIn>>;

  beforeAll(async () => {
    app = await buildApp({ auth: { auth: await testAuth(), config: testAuthConfig() } });
    await app.ready();
    // Cleared on the way IN as well as out: `--create` asserts that an account was provisioned,
    // which is only true against a database this suite has not already run on. Audit rows survive
    // (they cannot be deleted), and are counted per account id, which is new each time.
    await cleanupFixtures({ handles: HANDLES, emails: Object.values(EMAILS) });
    existing = await signIn(EMAILS.existing);
    await seedAccount({ userId: existing.userId, handle: "m3grant-existing" });
  }, 60_000);

  afterAll(async () => {
    await cleanupFixtures({ handles: HANDLES, emails: Object.values(EMAILS) });
    await app.close();
    await pool.end();
  }, 60_000);

  it("reports the target and writes nothing without --yes", async () => {
    const seeded = await accountFor(existing.userId);
    const { code, output } = await grantAdmin("--email", EMAILS.existing);

    expect(code).not.toBe(0);
    expect(output).toContain("refusing");
    // Everything an operator needs to recognise the database — and never the URL, which carries a
    // password.
    expect(output).toMatch(/database: [^ ]+:\d+\/\w+/);
    expect(output).not.toContain("rfphub:rfphub");
    expect(output).toContain(`id=${seeded?.id}`);
    expect(output).toContain("role=submitter");
    // The address resolved to a subject, and the subject is what was reported and stored.
    expect(output).toContain(`subject=${existing.userId}`);
    expect((await accountFor(existing.userId))?.globalRole).toBe("submitter");
  }, 60_000);

  it("promotes an existing account, and the promotion is live on the next request", async () => {
    const { code, output } = await grantAdmin("--email", EMAILS.existing, "--yes");
    expect(code, output).toBe(0);
    expect(output).toContain("is now an admin");

    const promoted = await accountFor(existing.userId);
    expect(promoted?.globalRole).toBe("admin");

    // The ceremony is only useful if the session that follows it is an admin's session.
    const me = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: bearer(existing.token),
    });
    expect(me.json().role).toBe("admin");
    expect(me.json().canAdmin).toBe(true);

    const grants = await roleGrants(promoted?.id ?? 0);
    expect(grants).toHaveLength(1);
    // No account acted — an operator with the database credential did, and the trail says that
    // rather than naming somebody who was not there.
    expect(grants[0]?.actorKind).toBe("job");
    expect(grants[0]?.actorAccountId).toBeNull();
    expect((grants[0]?.patch as { reason?: string })?.reason).toBe("operator_grant_admin");
  }, 60_000);

  it("is idempotent: a second run changes nothing and writes no second row", async () => {
    const { code, output } = await grantAdmin("--email", EMAILS.existing, "--yes");
    expect(code, output).toBe(0);
    expect(output).toContain("already an admin");
    expect(await roleGrants((await accountFor(existing.userId))?.id ?? 0)).toHaveLength(1);
  }, 60_000);

  it("refuses an address nobody has ever signed in as, and says what to do about it", async () => {
    // THE refusal that matters. An identity is created by signing in, not by this script, so there
    // is nothing here to promote — and the message has to say that rather than "not found", which
    // an operator would read as "I typed it wrong".
    const refused = await grantAdmin("--email", EMAILS.absent, "--yes");
    expect(refused.code).not.toBe(0);
    expect(refused.output).toContain("must sign in once");
    // …and NOT `--create`, which is the other refusal entirely: that flag provisions the accounts
    // row for an identity that already exists. It cannot conjure an identity, and offering it here
    // would send the operator to a flag that changes nothing.
    expect(refused.output).not.toContain("--create");
  }, 60_000);

  it("provisions the accounts row with --create for an identity that has never called the API", async () => {
    // Signed in, so the identity exists — but no `/v1` request was ever made, so JIT provisioning
    // never ran and there is no `accounts` row yet. That is what `--create` is for.
    const fresh = await signIn(EMAILS.fresh);
    expect(await accountFor(fresh.userId)).toBeUndefined();

    const refusedWithout = await grantAdmin("--email", EMAILS.fresh, "--yes");
    expect(refusedWithout.code).not.toBe(0);
    expect(refusedWithout.output).toContain("--create");

    const created = await grantAdmin("--email", EMAILS.fresh, "--create", "--yes");
    expect(created.code, created.output).toBe(0);
    const account = await accountFor(fresh.userId);
    expect(account?.globalRole).toBe("admin");
    expect(created.output).toContain(`created account id=${account?.id}`);
  }, 60_000);

  it("refuses a subject that names no identity, rather than minting a ghost admin", async () => {
    // THE HAZARD: there is deliberately no foreign key from `accounts.auth_user_id` to the identity
    // table (an accounts row must outlive its identity, because audit history points at it), so a
    // mistyped subject would sail through `--create` and produce an administrator nobody can ever
    // sign in as — one that then counts toward the last-admin guard.
    const typo = `${existing.userId}x`;
    const refused = await grantAdmin("--subject", typo, "--create", "--yes");
    expect(refused.code).not.toBe(0);
    expect(refused.output).toContain("no identity has the subject");
    expect(refused.output).toContain("--email");
    expect(await accountFor(typo)).toBeUndefined();
  }, 60_000);

  it("accepts --subject for an operator who already has the id", async () => {
    const bySubject = await grantAdmin("--subject", existing.userId, "--yes");
    expect(bySubject.code, bySubject.output).toBe(0);
    // Already an admin from the case above — the point is that the selector resolved, not that it
    // changed anything.
    expect(bySubject.output).toContain("already an admin");
    // …and it reports the identity it resolved, because `--subject` is checked against the identity
    // table too — see the case above for why.
    expect(bySubject.output).toContain(`identity: subject=${existing.userId}`);
  }, 60_000);

  it("refuses an unknown argument, no selector, and both selectors at once", async () => {
    expect((await grantAdmin("--email", EMAILS.existing, "--force")).code).not.toBe(0);
    expect((await grantAdmin("--yes")).code).not.toBe(0);
    expect(
      (await grantAdmin("--email", EMAILS.existing, "--subject", existing.userId, "--yes")).code,
    ).not.toBe(0);
  });

  it("accepts the package manager's own `--` separator, which the documented command carries", async () => {
    // `pnpm … grant-admin -- --did …` forwards the separator rather than swallowing it, so a parser
    // that treated it as an unknown argument would reject the exact invocation the docs give.
    const { code, output } = await grantAdmin("--", "--email", EMAILS.existing, "--yes");
    expect(code, output).toBe(0);
  });

  it("refuses to demote the last remaining admin", async () => {
    // The admin count is a fact about the WHOLE database, and the other suites keep their own
    // admins in it — so "the last one" is arranged inside a transaction that is rolled back at the
    // end. Nothing here is ever committed: the corpus never spends a moment with no administrator,
    // and the concurrent suites never see one demoted.
    const soleIdentity = await signIn(EMAILS.sole);
    const sole = await seedAccount({
      userId: soleIdentity.userId,
      handle: "m3grant-sole",
      role: "admin",
    });
    // Seeded OUTSIDE the arrangement: a pool-backed write against a row the open transaction has
    // touched would wait for a transaction that is waiting for it.
    const secondIdentity = await signIn(EMAILS.second);
    const second = await seedAccount({ userId: secondIdentity.userId, handle: "m3grant-second" });
    const rollback = new Error("rollback the arrangement");

    await expect(
      db.transaction(async (tx) => {
        await tx
          .update(accounts)
          .set({ globalRole: "submitter" })
          .where(and(eq(accounts.globalRole, "admin"), ne(accounts.id, sole.id)));

        const admins = new AdminService(tx as unknown as DB);
        // Self-demotion, which is the accident the guard exists for: the last admin removing their
        // own role locks the product out of every route that could restore it.
        await expect(admins.assignRole(sole.id, sole.id, "submitter")).rejects.toMatchObject({
          status: 409,
          code: "last_admin",
        });
        // Reviewer is a demotion too — the rule is about losing the admin, not about which role
        // replaces it.
        await expect(admins.assignRole(sole.id, sole.id, "reviewer")).rejects.toMatchObject({
          code: "last_admin",
        });

        // …and the moment a second admin exists, the same demotion is ordinary.
        await tx.update(accounts).set({ globalRole: "admin" }).where(eq(accounts.id, second.id));
        const demoted = await admins.assignRole(sole.id, sole.id, "submitter");
        expect(demoted.globalRole).toBe("submitter");

        throw rollback;
      }),
    ).rejects.toBe(rollback);

    // The arrangement left nothing behind: this account is exactly as it was seeded.
    expect((await accountFor(soleIdentity.userId))?.globalRole).toBe("admin");
  });
});
