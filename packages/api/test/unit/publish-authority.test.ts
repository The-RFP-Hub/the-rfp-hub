/**
 * The transactional half of "may this account publish into this namespace".
 *
 * `effectiveCaps` stays the pure place where the decision is made; this only supplies the two facts
 * underneath it, read inside the writing transaction. What is worth asserting without a database is
 * that each fact FAILS CLOSED on an absent row — a revoked membership and an account that cannot be
 * read must both yield no authority — and that the membership read asks for a lock at all, since a
 * plain read of it would leave the revocation race open exactly as before.
 */
import { describe, expect, it } from "vitest";
import type { Tx } from "../../src/db/client.js";
import { orgMemberships, organizations } from "../../src/db/schema.js";
import { resolvePublishAuthority } from "../../src/modules/services/auth/publish-authority.js";

/** What one query asked to lock: the strength, and the tables named in `of` (empty = the query's). */
interface Lock {
  strength: string;
  of: unknown[];
}

/**
 * A `tx` that answers each `select()` with the next prepared result set, and records the lock each
 * one asked for. Every chained builder method returns the same node and `limit()` — which both
 * queries end on — resolves it, so the fake is indifferent to the shape of the query and only the
 * order of the results matters.
 */
function fakeTx(...results: Record<string, unknown>[][]) {
  const pending = [...results];
  const locks: Lock[] = [];
  const tx = {
    select: () => {
      const rows = pending.shift() ?? [];
      const node: Record<string, unknown> = {
        limit: () => Promise.resolve(rows),
        for: (strength: string, config?: { of?: unknown }) => {
          const of = config?.of;
          locks.push({ strength, of: of === undefined ? [] : [of].flat() });
          return node;
        },
      };
      for (const method of ["from", "innerJoin", "where"]) {
        node[method] = () => node;
      }
      return node;
    },
  };
  return { tx: tx as unknown as Tx, locks };
}

const membership = (verified: boolean) => [{ verified }];
const account = (directCreate: boolean) => [{ directCreate }];

describe("resolvePublishAuthority", () => {
  it("reports a verified membership, and takes a share lock to read it", async () => {
    const { tx, locks } = fakeTx(membership(true), account(false));
    expect(await resolvePublishAuthority(tx, 1, "acme")).toEqual({
      member: true,
      verified: true,
      directCreate: false,
    });
    // Shared rather than exclusive: two writers are not in conflict with each other, only with
    // whoever is taking the authority away.
    expect(locks.map((lock) => lock.strength)).toEqual(["share", "share"]);
  });

  it("locks EVERY row the answer is derived from, not just the membership", async () => {
    // The gap this closes: locking the membership alone leaves `organizations.verified` and
    // `accounts.direct_create` free to be revoked and committed while the write is in flight, and
    // the write would still auto-publish on the values it read before that happened.
    const { tx, locks } = fakeTx(membership(true), account(true));
    await resolvePublishAuthority(tx, 1, "acme");
    const [publishing, granted] = locks;
    expect(publishing?.of).toContain(orgMemberships);
    expect(publishing?.of).toContain(organizations);
    // The account query selects from one table, so naming it in `of` would say nothing extra.
    expect(granted?.of).toEqual([]);
  });

  it("reports a membership on an unverified organisation as a membership that cannot publish", async () => {
    const { tx } = fakeTx(membership(false), account(false));
    expect(await resolvePublishAuthority(tx, 1, "acme")).toEqual({
      member: true,
      verified: false,
      directCreate: false,
    });
  });

  it("reports no authority at all once the membership row is gone", async () => {
    const { tx } = fakeTx([], account(false));
    expect(await resolvePublishAuthority(tx, 1, "acme")).toEqual({
      member: false,
      verified: false,
      directCreate: false,
    });
  });

  it("carries direct-create independently of any membership", async () => {
    const { tx } = fakeTx([], account(true));
    expect(await resolvePublishAuthority(tx, 1, "acme")).toEqual({
      member: false,
      verified: false,
      directCreate: true,
    });
  });

  it("grants nothing when the account row cannot be read", async () => {
    const { tx } = fakeTx(membership(true), []);
    expect(await resolvePublishAuthority(tx, 1, "acme")).toEqual({
      member: true,
      verified: true,
      directCreate: false,
    });
  });
});
