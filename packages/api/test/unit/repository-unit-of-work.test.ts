import { describe, expect, it, vi } from "vitest";
import type { DB, DbLike } from "../../src/db/client.js";
import {
  AuditRepository,
  MembershipInviteRepository,
  MembershipRepository,
  OpportunityRepository,
  OrganizationRepository,
  repositories,
  withTransaction,
} from "../../src/modules/repositories/index.js";

describe("repository unit of work", () => {
  it("exposes stable repositories through lazy getters", () => {
    const bundle = repositories({} as DbLike);
    const descriptor = Object.getOwnPropertyDescriptor(bundle, "opportunities");

    expect(descriptor?.get).toBeTypeOf("function");
    expect(bundle.audit).toBeInstanceOf(AuditRepository);
    expect(bundle.audit).toBe(bundle.audit);
    expect(bundle.membershipInvites).toBeInstanceOf(MembershipInviteRepository);
    expect(bundle.membershipInvites).toBe(bundle.membershipInvites);
    expect(bundle.memberships).toBeInstanceOf(MembershipRepository);
    expect(bundle.memberships).toBe(bundle.memberships);
    expect(bundle.opportunities).toBeInstanceOf(OpportunityRepository);
    expect(bundle.opportunities).toBe(bundle.opportunities);
    expect(bundle.organizations).toBeInstanceOf(OrganizationRepository);
    expect(bundle.organizations).toBe(bundle.organizations);
  });

  it("gives a transaction callback only the repository bundle", async () => {
    const tx = { marker: "raw transaction" };
    const transaction = vi.fn(async (run: (exec: unknown) => Promise<string>) => run(tx));
    const db = { transaction } as unknown as DB;

    const result = await withTransaction(db, async (bundle) => {
      expect(Object.keys(bundle)).toEqual([
        "audit",
        "membershipInvites",
        "memberships",
        "opportunities",
        "organizations",
      ]);
      expect(bundle).not.toBe(tx);
      expect("transaction" in bundle).toBe(false);
      return "committed";
    });

    expect(result).toBe("committed");
    expect(transaction).toHaveBeenCalledOnce();
  });
});
