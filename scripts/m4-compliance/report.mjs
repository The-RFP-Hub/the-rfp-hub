/**
 * The M4 report — the M2 one, plus the distinction M4 needs and M2 does not draw: whether a check
 * that could not be performed was a REQUIREMENT. A criterion where one required check went
 * unexercised (no `--browser`, a local MCP build standing in for a published one) is not a passed
 * criterion either, so `unmet()` makes it INCOMPLETE and the run exits non-zero. `warn()` keeps its
 * M2 meaning — the check HELD, but see this — and `skipOptional()` covers a check the criterion
 * genuinely does not depend on, such as TLS against a loopback origin.
 */
import {
  FAIL,
  INCOMPLETE,
  Criterion as M2Criterion,
  Report as M2Report,
  SKIP,
} from "../m2-compliance/report.mjs";

export {
  PASS,
  FAIL,
  WARN,
  SKIP,
  INFO,
  INCOMPLETE,
} from "../m2-compliance/report.mjs";

export class M4Criterion extends M2Criterion {
  #unmet = [];

  /** A REQUIRED check that could not be performed. Renders as a warning; blocks the sign-off. */
  unmet(name, detail, data) {
    this.#unmet.push(name);
    return this.warn(name, detail, data);
  }

  skip(name, detail, data) {
    this.#unmet.push(name);
    return super.skip(name, detail, data);
  }

  /** A skip this criterion does not depend on (no TLS to inspect on a loopback origin). */
  skipOptional(name, detail, data) {
    return super.skip(name, detail, data);
  }

  get unmetChecks() {
    return [...this.#unmet];
  }

  get status() {
    const inherited = super.status;
    if (inherited === FAIL) return FAIL;
    return this.#unmet.length > 0 ? INCOMPLETE : inherited;
  }
}

export class Report extends M2Report {
  criterion(id, name, describes) {
    const c = new M4Criterion(id, name, describes);
    this.criteria.push(c);
    return c;
  }

  get notExercised() {
    return this.criteria.filter((c) => c.status === SKIP || c.status === INCOMPLETE);
  }

  toJSON() {
    return {
      ...super.toJSON(),
      tool: "m4-compliance",
      signOff: this.meta.scopeLabel ? false : this.result === "pass",
      ...(this.meta.scopeLabel ? { scope: this.meta.scopeLabel } : {}),
    };
  }

  render(options = {}) {
    // `meta.baseUrl` is the API origin (so the inherited "API base URL" line is already correct);
    // the inherited "Export root URL" line is repointed at the site under test instead.
    const out = super
      .render(options)
      .replace("RFP Hub — M2 sign-off", "RFP Hub — M4 sign-off")
      .replace(/^ {2}Export root URL .*$/m, `  Site URL         ${this.meta.siteUrl}`)
      .replace("criterion(s) never exercised", "criterion(s) not established");
    if (!this.meta.scopeLabel) return out;
    // A scoped run answers a narrower question than "is M4 signed off", so it must never render
    // the bare headline that answer wears.
    return out.replace(
      /RESULT: (PASS|FAIL|INCOMPLETE)/,
      (_match, label) => `RESULT: SCOPED ${label} — ${this.meta.scopeLabel}`,
    );
  }
}
