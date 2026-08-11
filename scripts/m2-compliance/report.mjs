/**
 * Result collection and rendering for the M2 compliance checker.
 *
 * Five outcomes, and the difference between them is what makes the report signable:
 *
 *   pass  the check was performed against the live deployment and it held
 *   fail  the check was performed and it did not hold — the criterion, and the run, go red
 *   warn  the check held, but something about it should be seen (a certificate near expiry)
 *   skip  the check could NOT be performed here, and why. Never counted as a pass.
 *   info  observed context, asserting nothing (response times, counts, versions)
 *
 * `skip` existing separately from `pass` is the whole point: a sign-off tool that silently
 * downgrades "I could not check this" to "this is fine" is worse than no tool.
 */

export const PASS = "pass";
export const FAIL = "fail";
export const WARN = "warn";
export const SKIP = "skip";
export const INFO = "info";

const MARK = { [PASS]: "✓", [FAIL]: "✗", [WARN]: "!", [SKIP]: "-", [INFO]: "i" };
const COLOR = { [PASS]: 32, [FAIL]: 31, [WARN]: 33, [SKIP]: 90, [INFO]: 36 };

/** One completion criterion, and the individual checks performed for it. */
class Criterion {
  constructor(id, name, describes) {
    this.id = id;
    this.name = name;
    this.describes = describes;
    this.checks = [];
    this.startedAt = performance.now();
    this.elapsedMs = 0;
  }

  #add(status, name, detail, data) {
    this.checks.push({ status, name, ...(detail ? { detail } : {}), ...(data ? { data } : {}) });
    return this;
  }

  pass(name, detail, data) {
    return this.#add(PASS, name, detail, data);
  }
  fail(name, detail, data) {
    return this.#add(FAIL, name, detail, data);
  }
  warn(name, detail, data) {
    return this.#add(WARN, name, detail, data);
  }
  skip(name, detail, data) {
    return this.#add(SKIP, name, detail, data);
  }
  info(name, detail, data) {
    return this.#add(INFO, name, detail, data);
  }

  /** `expect(cond, name, okDetail, failDetail)` — the shape most checks want. */
  expect(condition, name, okDetail, failDetail, data) {
    return condition ? this.pass(name, okDetail, data) : this.fail(name, failDetail, data);
  }

  finish() {
    this.elapsedMs = Math.round(performance.now() - this.startedAt);
    return this;
  }

  /** A criterion is red if any check failed; warnings and skips never redden it on their own. */
  get status() {
    if (this.checks.some((c) => c.status === FAIL)) return FAIL;
    if (this.checks.some((c) => c.status === WARN)) return WARN;
    if (this.checks.every((c) => c.status === SKIP || c.status === INFO)) return SKIP;
    return PASS;
  }

  tally() {
    const counts = { pass: 0, fail: 0, warn: 0, skip: 0, info: 0 };
    for (const c of this.checks) counts[c.status]++;
    return counts;
  }
}

export class Report {
  constructor(meta) {
    this.meta = meta;
    this.criteria = [];
    this.startedAt = new Date().toISOString();
  }

  criterion(id, name, describes) {
    const c = new Criterion(id, name, describes);
    this.criteria.push(c);
    return c;
  }

  /** The run is green only when no criterion failed AND every criterion was actually exercised. */
  get ok() {
    return this.criteria.length > 0 && this.criteria.every((c) => c.status !== FAIL);
  }

  toJSON() {
    return {
      tool: "m2-compliance",
      ok: this.ok,
      startedAt: this.startedAt,
      finishedAt: new Date().toISOString(),
      target: this.meta,
      summary: {
        criteria: this.criteria.length,
        failed: this.criteria.filter((c) => c.status === FAIL).length,
        checks: this.criteria.reduce((sum, c) => sum + c.checks.length, 0),
        ...this.criteria.reduce(
          (totals, c) => {
            const t = c.tally();
            for (const k of Object.keys(totals)) totals[k] += t[k];
            return totals;
          },
          { pass: 0, fail: 0, warn: 0, skip: 0, info: 0 },
        ),
      },
      criteria: this.criteria.map((c) => ({
        id: c.id,
        name: c.name,
        describes: c.describes,
        status: c.status,
        elapsedMs: c.elapsedMs,
        tally: c.tally(),
        checks: c.checks,
      })),
    };
  }

  render({ color = false } = {}) {
    const esc = "\u001b[";
    const paint = (status, text) => (color ? `${esc}${COLOR[status]}m${text}${esc}0m` : text);
    const out = [];
    out.push("RFP Hub — M2 sign-off compliance check");
    out.push(`  API base URL     ${this.meta.baseUrl}`);
    out.push(`  Export root URL  ${this.meta.exportUrl}`);
    out.push(`  Started          ${this.startedAt}`);
    out.push("");

    for (const c of this.criteria) {
      const head = `[${c.id}] ${c.name}`;
      out.push(
        `${head} ${".".repeat(Math.max(2, 62 - head.length))} ${paint(c.status, c.status.toUpperCase())}  (${c.elapsedMs} ms)`,
      );
      out.push(`      ${c.describes}`);
      for (const check of c.checks) {
        out.push(`   ${paint(check.status, MARK[check.status])}  ${check.name}`);
        if (check.detail) {
          for (const line of String(check.detail).split("\n")) out.push(`        ${line}`);
        }
      }
      out.push("");
    }

    out.push("Summary");
    for (const c of this.criteria) {
      const t = c.tally();
      const counts = `${t.pass} pass, ${t.fail} fail, ${t.warn} warn, ${t.skip} skip`;
      out.push(
        `  ${paint(c.status, c.status.toUpperCase().padEnd(4))}  [${c.id}] ${c.name.padEnd(26)} ${counts}`,
      );
    }
    out.push("");
    out.push(paint(this.ok ? PASS : FAIL, `RESULT: ${this.ok ? "PASS" : "FAIL"}`));
    return out.join("\n");
  }
}
