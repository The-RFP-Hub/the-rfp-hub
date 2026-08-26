import { describe, expect, it, vi } from "vitest";
import type { DB, DbLike } from "../../src/db/client.js";
import {
  AuditRepository,
  OpportunityRepository,
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
    expect(bundle.opportunities).toBeInstanceOf(OpportunityRepository);
    expect(bundle.opportunities).toBe(bundle.opportunities);
  });

  it("gives a transaction callback only the repository bundle", async () => {
    const tx = { marker: "raw transaction" };
    const transaction = vi.fn(async (run: (exec: unknown) => Promise<string>) => run(tx));
    const db = { transaction } as unknown as DB;

    const result = await withTransaction(db, async (bundle) => {
      expect(Object.keys(bundle)).toEqual(["audit", "opportunities"]);
      expect(bundle).not.toBe(tx);
      expect("transaction" in bundle).toBe(false);
      return "committed";
    });

    expect(result).toBe("committed");
    expect(transaction).toHaveBeenCalledOnce();
  });
});
