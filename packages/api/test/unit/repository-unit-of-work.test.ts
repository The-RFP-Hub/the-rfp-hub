import { describe, expect, it, vi } from "vitest";
import type { DB, DbLike } from "../../src/db/client.js";
import {
  AccountRepository,
  AnalyticsRepository,
  ApiKeyRepository,
  AuditRepository,
  ClaimRepository,
  MembershipInviteRepository,
  MembershipRepository,
  NotificationRepository,
  OpportunityRepository,
  OrganizationRepository,
  VerificationRunRepository,
  repositories,
  withTransaction,
} from "../../src/modules/repositories/index.js";

describe("repository unit of work", () => {
  it("exposes stable repositories through lazy getters", () => {
    const bundle = repositories({} as DbLike);
    const descriptor = Object.getOwnPropertyDescriptor(bundle, "opportunities");

    expect(descriptor?.get).toBeTypeOf("function");
    expect(bundle.accounts).toBeInstanceOf(AccountRepository);
    expect(bundle.accounts).toBe(bundle.accounts);
    expect(bundle.apiKeys).toBeInstanceOf(ApiKeyRepository);
    expect(bundle.apiKeys).toBe(bundle.apiKeys);
    expect(bundle.audit).toBeInstanceOf(AuditRepository);
    expect(bundle.audit).toBe(bundle.audit);
    expect(bundle.analytics).toBeInstanceOf(AnalyticsRepository);
    expect(bundle.analytics).toBe(bundle.analytics);
    expect(bundle.claims).toBeInstanceOf(ClaimRepository);
    expect(bundle.claims).toBe(bundle.claims);
    expect(bundle.membershipInvites).toBeInstanceOf(MembershipInviteRepository);
    expect(bundle.membershipInvites).toBe(bundle.membershipInvites);
    expect(bundle.memberships).toBeInstanceOf(MembershipRepository);
    expect(bundle.memberships).toBe(bundle.memberships);
    expect(bundle.notifications).toBeInstanceOf(NotificationRepository);
    expect(bundle.notifications).toBe(bundle.notifications);
    expect(bundle.opportunities).toBeInstanceOf(OpportunityRepository);
    expect(bundle.opportunities).toBe(bundle.opportunities);
    expect(bundle.organizations).toBeInstanceOf(OrganizationRepository);
    expect(bundle.organizations).toBe(bundle.organizations);
    expect(bundle.verificationRuns).toBeInstanceOf(VerificationRunRepository);
    expect(bundle.verificationRuns).toBe(bundle.verificationRuns);
  });

  it("gives a transaction callback only the repository bundle", async () => {
    const tx = { marker: "raw transaction" };
    const transaction = vi.fn(async (run: (exec: unknown) => Promise<string>) => run(tx));
    const db = { transaction } as unknown as DB;

    const result = await withTransaction(db, async (bundle) => {
      expect(Object.keys(bundle)).toEqual([
        "accounts",
        "apiKeys",
        "audit",
        "analytics",
        "claims",
        "duplicatePairs",
        "embeddings",
        "membershipInvites",
        "memberships",
        "notifications",
        "opportunities",
        "organizations",
        "verificationRuns",
      ]);
      expect(bundle).not.toBe(tx);
      expect("transaction" in bundle).toBe(false);
      return "committed";
    });

    expect(result).toBe("committed");
    expect(transaction).toHaveBeenCalledOnce();
  });
});
