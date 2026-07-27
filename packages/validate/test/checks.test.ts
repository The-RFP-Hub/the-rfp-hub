import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { run } from "../src/cli/run.js";
import { checks, runChecks, validateOpportunity } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const conformance = join(here, "..", "..", "standard", "conformance", "v1.0.0");

const base = {
  specVersion: "1.0.0",
  id: "checks",
  fundingType: "grant" as const,
  title: "T",
  description: "D",
  status: "open" as const,
  sponsoringOrganizations: [{ name: "Org" }],
  source: {},
  grant: {},
};

const codes = (data: unknown) => runChecks(data).map((w) => w.code);

describe("advisory tier is separate from schema conformance", () => {
  it("does not make a warning-carrying document invalid", () => {
    const doc = { ...base, eligibility: { madeUpKey: "whatever" } };
    const { valid, warnings } = validateOpportunity(doc);
    expect(valid).toBe(true);
    expect(warnings.map((w) => w.code)).toEqual(["unregistered-eligibility-key"]);
  });

  it("can be switched off", () => {
    const doc = { ...base, eligibility: { madeUpKey: "whatever" } };
    expect(validateOpportunity(doc, { checks: false }).warnings).toEqual([]);
  });

  it("every check declares a count-phrase for the text reporter", () => {
    for (const check of checks) {
      expect(check.entryPhrase.length).toBeGreaterThan(0);
      expect(check.code).toMatch(/^[a-z-]+$/);
    }
  });
});

describe("unregistered-eligibility-key", () => {
  it("stays quiet on registered keys", () => {
    expect(codes({ ...base, eligibility: { stage: "seed", jurisdiction: "global" } })).toEqual([]);
  });

  it("fires once per unregistered key, naming it", () => {
    const warnings = runChecks({ ...base, eligibility: { projectStage: "seed", region: "EU" } });
    expect(warnings).toHaveLength(2);
    expect(warnings[0]?.instancePath).toBe("/eligibility/projectStage");
    expect(warnings[0]?.message).toContain("projectStage");
  });
});

describe("unregistered-deadline-label", () => {
  it("stays quiet on registered labels", () => {
    const deadlines = [
      { type: "fixed", date: "2026-01-01T00:00:00.000Z", label: "application" },
      { type: "fixed", date: "2026-01-02T00:00:00.000Z", label: "event start" },
    ];
    expect(codes({ ...base, deadlines })).toEqual([]);
  });

  it("fires on an unregistered label", () => {
    const deadlines = [{ type: "rolling", label: "reviewed quarterly" }];
    expect(codes({ ...base, deadlines })).toEqual(["unregistered-deadline-label"]);
  });

  it("ignores a missing or null label", () => {
    expect(
      codes({ ...base, deadlines: [{ type: "rolling" }, { type: "rolling", label: null }] }),
    ).toEqual([]);
  });
});

describe("unregistered-program-model", () => {
  it("stays quiet on registered values", () => {
    expect(codes({ ...base, grant: { programModel: "incentives" } })).toEqual([]);
  });

  it("fires on a publisher's own vocabulary", () => {
    expect(codes({ ...base, grant: { programModel: "Retro Rounds" } })).toEqual([
      "unregistered-program-model",
    ]);
  });
});

describe("milestone-amount-without-currency", () => {
  it("stays quiet when the envelope names a currency", () => {
    const doc = { ...base, funding: { currency: "USD" }, milestones: [{ amount: 1000 }] };
    expect(codes(doc)).toEqual([]);
  });

  it("fires per amount when there is no envelope currency", () => {
    const doc = { ...base, milestones: [{ amount: 1000 }, { title: "no amount" }, { amount: 2 }] };
    const warnings = runChecks(doc);
    expect(warnings.map((w) => w.code)).toEqual([
      "milestone-amount-without-currency",
      "milestone-amount-without-currency",
    ]);
    expect(warnings[0]?.instancePath).toBe("/milestones/0/amount");
  });

  it("fires when funding exists but carries no currency", () => {
    const doc = { ...base, funding: { budget: 10 }, milestones: [{ amount: 1000 }] };
    expect(codes(doc)).toEqual(["milestone-amount-without-currency"]);
  });
});

describe("--strict", () => {
  const passDir = join(conformance, "pass");

  it("exits 0 on the conformance pass suite without --strict", () => {
    expect(run(["--quiet", passDir])).toBe(0);
  });

  it("exits 1 when a warning is present and --strict is set", () => {
    // full-featured.json carries the rolling "reviewed quarterly after the first round"
    // label, which is deliberately unregistered — free text is allowed, drift is visible.
    const doc = JSON.parse(readFileSync(join(passDir, "full-featured.json"), "utf8"));
    expect(runChecks(doc).length).toBeGreaterThan(0);
    expect(run(["--quiet", "--strict", join(passDir, "full-featured.json")])).toBe(1);
    expect(run(["--quiet", join(passDir, "full-featured.json")])).toBe(0);
  });
});
