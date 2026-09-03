/**
 * The aggregation rule of the sign-off tool.
 *
 * This is the one line in the checker most worth a test. Everything else in the tool reports what a
 * live deployment did; this decides what the run as a whole SAYS about it, and it is the only line
 * whose output someone signs. It is also the line where the two easy mistakes live: treating a
 * criterion nothing could be checked in as a pass, and hiding a legitimate skip inside a green
 * headline so nobody knows something went unlooked-at.
 *
 * The cases below are the boundary between those two mistakes:
 *
 *   A  an all-skip criterion              -> INCOMPLETE, exit 1  (nothing was established)
 *   B  passing criteria + one all-skip    -> INCOMPLETE, exit 1  (the good ones do not cover it)
 *   C  a skip INSIDE an exercised one     -> PASS, exit 0        (the loopback TLS case)
 *   D  an info-only criterion             -> INCOMPLETE          (observing is not asserting)
 *   E  a criterion with no checks at all  -> INCOMPLETE          (vacuous truth is not a sign-off)
 *
 * C is the one that has to keep working: a plaintext loopback origin has no transport to verify,
 * and a tool that reddens a run over that gets ignored, which is its own kind of failure.
 */
import { describe, expect, it } from "vitest";
import { FAIL, INCOMPLETE, PASS, Report } from "../report.mjs";

const meta = { baseUrl: "http://127.0.0.1:3001", exportUrl: "http://127.0.0.1:8081" };

/** A report with one criterion per spec: each spec is a list of check statuses to record. */
const build = (...specs) => {
  const report = new Report(meta);
  specs.forEach((statuses, i) => {
    const c = report.criterion(String(i + 1), `Criterion ${i + 1}`, "describes");
    for (const status of statuses) c[status](`${status} check`, "detail");
    c.finish();
  });
  return report;
};

describe("compliance run aggregation", () => {
  it("A — a criterion in which every check was skipped is not a pass", () => {
    const report = build(["skip", "skip"]);
    expect(report.result).toBe(INCOMPLETE);
    expect(report.ok).toBe(false);
    expect(report.notExercised.map((c) => c.id)).toEqual(["1"]);
    expect(report.render()).toContain("RESULT: INCOMPLETE");
  });

  it("B — passing criteria do not cover for one that was never exercised", () => {
    const report = build(["pass"], ["pass", "pass"], ["pass"], ["skip"]);
    expect(report.result).toBe(INCOMPLETE);
    expect(report.ok).toBe(false);
    // the headline names WHICH criterion, so the reader does not have to open the JSON to find out
    expect(report.render()).toContain("RESULT: INCOMPLETE (1 criterion(s) never exercised: 4");
    expect(report.render()).toContain("1 check(s) skipped");
  });

  it("C — a skipped check inside an exercised criterion stays green, and stays visible", () => {
    // the shape of the documented run: criterion 1 is 4 pass + the loopback TLS skip
    const report = build(["pass", "pass", "pass", "pass", "skip"], ["pass"], ["pass"], ["pass"]);
    expect(report.result).toBe(PASS);
    expect(report.ok).toBe(true);
    expect(report.notExercised).toEqual([]);
    // green, and the skip is in the headline anyway — a pass that quietly drops it is the failure
    // mode this whole rule exists to prevent, in the opposite direction
    expect(report.render()).toContain("RESULT: PASS (1 check(s) skipped)");
    expect(report.render()).not.toContain("INCOMPLETE");
  });

  it("C — a clean run says PASS with nothing appended", () => {
    const report = build(["pass"], ["pass"], ["pass"], ["pass"]);
    expect(report.result).toBe(PASS);
    expect(report.render()).toContain("RESULT: PASS");
    expect(report.render()).not.toContain("skipped");
  });

  it("D — a criterion that only recorded observations asserted nothing", () => {
    const report = build(["pass"], ["info", "info"]);
    expect(report.result).toBe(INCOMPLETE);
    expect(report.notExercised.map((c) => c.id)).toEqual(["2"]);
  });

  it("E — a criterion with no checks at all is vacuous, not green", () => {
    const report = build(["pass"], []);
    expect(report.result).toBe(INCOMPLETE);
    expect(report.ok).toBe(false);
    expect(report.toJSON().summary.checks).toBe(1);
  });

  it("a failure outranks an unexercised criterion", () => {
    const report = build(["fail"], ["skip"]);
    expect(report.result).toBe(FAIL);
    expect(report.ok).toBe(false);
    expect(report.render()).toContain("RESULT: FAIL");
  });

  it("a warning is not a failure, and does not make a criterion unexercised", () => {
    const report = build(["pass", "warn"], ["pass"]);
    expect(report.result).toBe(PASS);
    expect(report.ok).toBe(true);
  });

  it("a report with no criteria at all is a failure, not a vacuous pass", () => {
    const report = new Report(meta);
    expect(report.result).toBe(FAIL);
    expect(report.ok).toBe(false);
  });

  it("the JSON report carries the three-valued result beside the boolean", () => {
    const json = build(["pass"], ["skip"]).toJSON();
    expect(json.ok).toBe(false);
    expect(json.result).toBe(INCOMPLETE);
    expect(json.summary.notExercised).toBe(1);
    expect(json.summary.failed).toBe(0);
    // `ok` stays a boolean: existing consumers keep working, they just stop being told that a run
    // which checked nothing was fine
    expect(typeof json.ok).toBe("boolean");
  });

  it("counts skipped checks across every criterion", () => {
    const report = build(["pass", "skip"], ["pass", "skip", "skip"]);
    expect(report.skippedChecks).toBe(3);
    expect(report.result).toBe(PASS);
    expect(report.render()).toContain("RESULT: PASS (3 check(s) skipped)");
  });
});

/**
 * `unmet()` is the distinction `skip()` deliberately does not draw. `--only frontend` without
 * `--browser` used to print RESULT: PASS and exit 0 with nine browser checks at WARN, because a
 * criterion carrying warnings passes. A check the criterion DEPENDS on is a different thing from
 * one it does not, and only the second may stay green.
 */
describe("a required check that could not be performed", () => {
  it("makes its criterion INCOMPLETE and the run non-green", () => {
    const report = new Report(meta);
    const c = report.criterion("frontend", "Reference frontend", "d");
    c.pass("something real");
    c.unmet("rendered slugs equal the API's", "needs --browser");
    c.finish();
    expect(c.status).toBe(INCOMPLETE);
    expect(report.result).toBe(INCOMPLETE);
    expect(report.ok).toBe(false);
  });

  it("is listed by name, in the headline and in the JSON", () => {
    const report = new Report(meta);
    report.criterion("frontend", "Reference frontend", "d").unmet("rendered slugs", "no browser");
    expect(report.render()).toContain("frontend (rendered slugs)");
    expect(report.toJSON().criteria[0].unmet).toEqual(["rendered slugs"]);
  });

  it("a plain warn still passes, and an optional skip still passes", () => {
    const report = new Report(meta);
    const c = report.criterion("liveness", "API liveness", "d");
    c.pass("held");
    c.warn("TLS certificate lifetime", "only 9 day(s) remaining");
    c.skip("TLS certificate is valid", "loopback origin, no transport to inspect");
    c.finish();
    expect(c.status).toBe("warn");
    expect(report.result).toBe(PASS);
  });

  it("a failure still outranks an unmet requirement", () => {
    const report = new Report(meta);
    const c = report.criterion("mcp", "MCP server", "d");
    c.fail("callable", "no");
    c.unmet("published", "needs the registry");
    expect(c.status).toBe(FAIL);
    expect(report.result).toBe(FAIL);
  });
});

describe("scoped and mapped runs", () => {
  it("a scoped run never renders the bare sign-off headline", () => {
    const report = new Report({
      ...meta,
      scopeLabel: "write acceptance — NOT a deployment sign-off",
    });
    report.criterion("lifecycle", "Publisher lifecycle", "d").pass("held").finish();
    const rendered = report.render();
    expect(rendered).toContain("RESULT: SCOPED PASS");
    expect(rendered).not.toMatch(/RESULT: PASS/);
    expect(report.toJSON().signOff).toBe(false);
  });

  it("an unscoped green run is a sign-off", () => {
    const report = build(["pass"]);
    expect(report.toJSON().signOff).toBe(true);
    expect(report.render()).toContain("RESULT: PASS");
  });

  it("a milestone stamps the contract id beside the capability key, never over it", () => {
    const report = new Report({
      ...meta,
      milestone: "m3",
      contractIds: { lifecycle: "M3-1", teardown: null },
    });
    report.criterion("lifecycle", "Publisher lifecycle", "d").pass("held").finish();
    report.criterion("teardown", "Fixture teardown", "d").pass("held").finish();
    const json = report.toJSON();
    expect(json.milestone).toBe("m3");
    expect(json.criteria.map((c) => [c.id, c.contractId])).toEqual([
      ["lifecycle", "M3-1"],
      ["teardown", null],
    ]);
    expect(report.render()).toContain("[lifecycle · M3-1]");
    // the presentational half of `meta` never leaks into the target the report says it checked
    expect(json.target).not.toHaveProperty("contractIds");
    expect(json.target).not.toHaveProperty("milestone");
  });

  it("carries no milestone key at all when none was asked for", () => {
    const json = build(["pass"]).toJSON();
    expect(json).not.toHaveProperty("milestone");
    expect(json.criteria[0]).not.toHaveProperty("contractId");
  });
});
