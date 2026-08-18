/**
 * The admin ceremony: the one grant the product cannot make, and the guard that keeps the product
 * from undoing it into a state only the ceremony can leave.
 *
 * The script is driven through its exported `main` rather than a subprocess: a spawned `tsx` would
 * assert the same behaviour twice as slowly, and what a test wants to read is what it PRINTED,
 * which a return value and a collected sink give directly.
 *
 * Isolation tag: `M3GRANT` / `did:privy:m3grant-*`.
 */
import { and, eq, ne } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";
import { main } from "../../scripts/grant-admin.js";
import { buildApp } from "../../src/app.js";
import { type DB, db, pool } from "../../src/db/client.js";
import { accounts, auditLog } from "../../src/db/schema.js";
import { AdminService } from "../../src/modules/services/admin/admin.service.js";
import { bearer, mintPrivyToken, seedAccount, testPrivyConfig } from "../helpers/auth.js";
import { cleanupFixtures } from "../helpers/cleanup.js";
import { describeWithDb } from "./db-gate.js";

const DIDS = {
  existing: "did:privy:m3grant-existing",
  fresh: "did:privy:m3grant-fresh",
  absent: "did:privy:m3grant-absent",
  sole: "did:privy:m3grant-sole",
  second: "did:privy:m3grant-second",
};

const run = describeWithDb;

/** Run the script, collecting what it printed. */
async function grantAdmin(...argv: string[]): Promise<{ code: number; output: string }> {
  const lines: string[] = [];
  const code = await main(argv, (line) => lines.push(line));
  return { code, output: lines.join("\n") };
}

const accountFor = async (did: string) =>
  (await db.select().from(accounts).where(eq(accounts.privyDid, did)).limit(1))[0];

const roleGrants = async (accountId: number) =>
  (
    await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.subjectKind, "account"), eq(auditLog.subjectId, accountId)))
  ).filter((row) => row.action === "assign_role");

run("M3GRANT the admin ceremony", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ auth: { privy: await testPrivyConfig() } });
    await app.ready();
    // Cleared on the way IN as well as out: `--create` asserts that an account was provisioned,
    // which is only true against a database this suite has not already run on. Audit rows survive
    // (they cannot be deleted), and are counted per account id, which is new each time.
    await cleanupFixtures({ privyDids: Object.values(DIDS) });
    await seedAccount({ did: DIDS.existing, handle: "m3grant-existing" });
  }, 30_000);

  afterAll(async () => {
    await cleanupFixtures({ privyDids: Object.values(DIDS) });
    await app.close();
    await pool.end();
  }, 30_000);

  it("reports the target and writes nothing without --yes", async () => {
    const seeded = await accountFor(DIDS.existing);
    const { code, output } = await grantAdmin("--did", DIDS.existing);

    expect(code).not.toBe(0);
    expect(output).toContain("refusing");
    // Everything an operator needs to recognise the database — and never the URL, which carries a
    // password.
    expect(output).toMatch(/database: [^ ]+:\d+\/\w+/);
    expect(output).not.toContain("rfphub:rfphub");
    expect(output).toContain(`id=${seeded?.id}`);
    expect(output).toContain("role=submitter");
    expect((await accountFor(DIDS.existing))?.globalRole).toBe("submitter");
  });

  it("promotes an existing account, and the promotion is live on the next request", async () => {
    const { code, output } = await grantAdmin("--did", DIDS.existing, "--yes");
    expect(code, output).toBe(0);
    expect(output).toContain("is now an admin");

    const promoted = await accountFor(DIDS.existing);
    expect(promoted?.globalRole).toBe("admin");

    // The ceremony is only useful if the session that follows it is an admin's session.
    const me = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: bearer(await mintPrivyToken(DIDS.existing)),
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
  });

  it("is idempotent: a second run changes nothing and writes no second row", async () => {
    const { code, output } = await grantAdmin("--did", DIDS.existing, "--yes");
    expect(code, output).toBe(0);
    expect(output).toContain("already an admin");
    expect(await roleGrants((await accountFor(DIDS.existing))?.id ?? 0)).toHaveLength(1);
  });

  it("refuses a subject that has never logged in, and provisions it with --create", async () => {
    const refused = await grantAdmin("--did", DIDS.absent, "--yes");
    expect(refused.code).not.toBe(0);
    expect(refused.output).toContain("--create");
    expect(await accountFor(DIDS.absent)).toBeUndefined();

    const created = await grantAdmin("--did", DIDS.fresh, "--create", "--yes");
    expect(created.code, created.output).toBe(0);
    const account = await accountFor(DIDS.fresh);
    expect(account?.globalRole).toBe("admin");
    expect(created.output).toContain(`created account id=${account?.id}`);
  });

  it("refuses an unknown argument and a missing --did", async () => {
    expect((await grantAdmin("--did", DIDS.existing, "--force")).code).not.toBe(0);
    expect((await grantAdmin("--yes")).code).not.toBe(0);
  });

  it("accepts the package manager's own `--` separator, which the documented command carries", async () => {
    // `pnpm … grant-admin -- --did …` forwards the separator rather than swallowing it, so a parser
    // that treated it as an unknown argument would reject the exact invocation the docs give.
    const { code, output } = await grantAdmin("--", "--did", DIDS.existing, "--yes");
    expect(code, output).toBe(0);
  });

  it("refuses to demote the last remaining admin", async () => {
    // The admin count is a fact about the WHOLE database, and the other suites keep their own
    // admins in it — so "the last one" is arranged inside a transaction that is rolled back at the
    // end. Nothing here is ever committed: the corpus never spends a moment with no administrator,
    // and the concurrent suites never see one demoted.
    const sole = await seedAccount({ did: DIDS.sole, handle: "m3grant-sole", role: "admin" });
    // Seeded OUTSIDE the arrangement: a pool-backed write against a row the open transaction has
    // touched would wait for a transaction that is waiting for it.
    const second = await seedAccount({ did: DIDS.second, handle: "m3grant-second" });
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
    expect((await accountFor(DIDS.sole))?.globalRole).toBe("admin");
  });
});
