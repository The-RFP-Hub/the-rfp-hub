import {
  canonicalForm,
  clearAllOpportunityDrafts,
  opportunityDraftKey,
  readOpportunityDraft,
  writeOpportunityDraft,
} from "@/lib/opportunity-draft";
import { emptyForm, emptyOrganization, emptyPrize, emptyRewardTier } from "@/lib/opportunity-form";
import { beforeEach, describe, expect, it } from "vitest";

function draft(title: string) {
  const form = emptyForm();
  form.title = title;
  form.details.rfp.scope = "Inactive branches stay in the draft.";
  form.operatingOrganizations = [
    {
      ...emptyOrganization(),
      name: "Acme Foundation",
      slug: "acme",
      base: { privateCarry: true },
    },
  ];
  form.details.hackathon.prizes = [
    { ...emptyPrize(), track: "Infrastructure", amount: "1000", base: { old: true } },
  ];
  form.details.bounty.rewardTiers = [{ ...emptyRewardTier(), severity: "high" }];
  return form;
}

describe("account-scoped opportunity drafts", () => {
  beforeEach(() => localStorage.clear());

  it("isolates accounts, strips carry-through records, and regenerates repeater keys", () => {
    const first = draft("First account");
    const oldKey = first.operatingOrganizations[0]?.key;
    writeOpportunityDraft(7, first, {
      now: new Date("2026-08-25T12:00:00.000Z"),
    });
    writeOpportunityDraft(8, draft("Second account"), {
      now: new Date("2026-08-25T12:00:00.000Z"),
    });

    const restored = readOpportunityDraft(7, { now: Date.parse("2026-08-26T12:00:00.000Z") });
    expect(restored.kind).toBe("draft");
    if (restored.kind !== "draft") return;
    expect(restored.form.title).toBe("First account");
    expect(restored.form.details.rfp.scope).toBe("Inactive branches stay in the draft.");
    expect(restored.form.operatingOrganizations[0]?.key).not.toBe(oldKey);
    expect(restored.form.operatingOrganizations[0]?.base).toEqual({});
    expect(restored.form.details.hackathon.prizes[0]?.base).toEqual({});

    const stored = localStorage.getItem(opportunityDraftKey(7)) ?? "";
    expect(stored).not.toContain("privateCarry");
    expect(stored).not.toContain('"key"');
    expect(stored).not.toContain('"base"');
  });

  it("expires drafts after 30 days", () => {
    writeOpportunityDraft(7, draft("Old"), { now: new Date("2026-07-01T00:00:00.000Z") });

    expect(readOpportunityDraft(7, { now: Date.parse("2026-08-01T00:00:00.001Z") })).toEqual({
      kind: "none",
    });
    expect(localStorage.getItem(opportunityDraftKey(7))).toBeNull();
  });

  it("rejects malformed stored shapes instead of spreading them into form state", () => {
    localStorage.setItem(
      opportunityDraftKey(7),
      JSON.stringify({
        version: 1,
        accountId: 7,
        savedAt: "2026-08-25T12:00:00.000Z",
        form: { title: 42 },
      }),
    );

    expect(readOpportunityDraft(7, { now: Date.parse("2026-08-25T13:00:00.000Z") })).toEqual({
      kind: "none",
    });
  });

  it("turns storage exceptions into results the form can render", () => {
    const storage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("full");
      },
    } as unknown as Storage;

    expect(readOpportunityDraft(7, { storage })).toEqual({ kind: "error" });
    expect(writeOpportunityDraft(7, draft("Unsaved"), { storage })).toEqual({ ok: false });
  });

  it("clears every listing draft without touching unrelated storage", () => {
    writeOpportunityDraft(7, draft("First"));
    writeOpportunityDraft(8, draft("Second"));
    localStorage.setItem("rfphub.preference", "kept");

    expect(clearAllOpportunityDrafts()).toBe(true);
    expect(localStorage.getItem(opportunityDraftKey(7))).toBeNull();
    expect(localStorage.getItem(opportunityDraftKey(8))).toBeNull();
    expect(localStorage.getItem("rfphub.preference")).toBe("kept");
  });
});

describe("canonical dirty comparison", () => {
  it("ignores fresh repeater keys but includes inactive funding branches", () => {
    const first = draft("Same");
    const second = draft("Same");
    expect(canonicalForm(first)).toBe(canonicalForm(second));

    second.details.rfp.scope = "Changed while grant is active.";
    expect(canonicalForm(first)).not.toBe(canonicalForm(second));
  });
});
