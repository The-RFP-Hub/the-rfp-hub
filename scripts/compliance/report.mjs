/**
 * Result collection and rendering for the compliance checkers.
 *
 * Six check outcomes, and two of them carry the whole value of a sign-off tool:
 *
 *   skip   could NOT be performed, and the criterion does not depend on it. Stays green.
 *   unmet  could NOT be performed, and the criterion DOES depend on it (no `--browser`, a local
 *          build standing in for a published one). Renders as a warning and makes the criterion
 *          INCOMPLETE, so the run exits non-zero.
 *
 * A tool that silently downgrades "I could not check this" to "this is fine" is worse than no tool,
 * and the same rule applies one level up: a criterion nothing could be checked in is not a
 * criterion that passed, so the RUN has three outcomes rather than two — see `Report.result`.
 */

export const PASS = "pass";
export const FAIL = "fail";
export const WARN = "warn";
export const SKIP = "skip";
export const INFO = "info";

export const INCOMPLETE = "incomplete";

const MARK = { [PASS]: "✓", [FAIL]: "✗", [WARN]: "!", [SKIP]: "-", [INFO]: "i" };
const COLOR = { [PASS]: 32, [FAIL]: 31, [WARN]: 33, [SKIP]: 90, [INFO]: 36, [INCOMPLETE]: 33 };

function heading(criterion) {
  return criterion.contractId ? `${criterion.id} · ${criterion.contractId}` : criterion.id;
}

export class Criterion {
  #unmet = [];

  constructor(id, name, describes, contractId) {
    this.id = id;
    this.name = name;
    this.describes = describes;
    this.contractId = contractId;
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

  /** A REQUIRED check that could not be performed. Renders as a warning; blocks the sign-off. */
  unmet(name, detail, data) {
    this.#unmet.push(name);
    return this.warn(name, detail, data);
  }

  get unmetChecks() {
    return [...this.#unmet];
  }

  /** `expect(cond, name, okDetail, failDetail)` — the shape most checks want. */
  expect(condition, name, okDetail, failDetail, data) {
    return condition ? this.pass(name, okDetail, data) : this.fail(name, failDetail, data);
  }

  finish() {
    this.elapsedMs = Math.round(performance.now() - this.startedAt);
    return this;
  }

  /** A criterion is red if any check failed; warnings and optional skips never redden it alone. */
  get status() {
    if (this.checks.some((c) => c.status === FAIL)) return FAIL;
    if (this.#unmet.length > 0) return INCOMPLETE;
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

/** A write run registers acceptance criteria, not milestone rows: it is never a sign-off. */
export const ACCEPTANCE_SCOPE = "write acceptance — NOT a deployment sign-off";

export function acceptanceReport(meta) {
  return new Report({ ...meta, scopeLabel: ACCEPTANCE_SCOPE });
}

export class Report {
  constructor(meta) {
    this.meta = meta;
    this.criteria = [];
    this.startedAt = new Date().toISOString();
  }

  /** The contract id is looked up, not passed: a criterion must not know which milestone runs it. */
  criterion(id, name, describes) {
    const c = new Criterion(id, name, describes, this.meta.contractIds?.[id]);
    this.criteria.push(c);
    return c;
  }

  get notExercised() {
    return this.criteria.filter((c) => c.status === SKIP || c.status === INCOMPLETE);
  }

  get skippedChecks() {
    return this.criteria.reduce((n, c) => n + c.tally().skip, 0);
  }

  /**
   * Three outcomes, because a sign-off has three: pass, fail, and incomplete — nothing failed, but
   * a criterion was never exercised or left a requirement unmet, so the run does not establish the
   * milestone and must not exit 0. A report with no criteria at all is FAIL: a report about nothing
   * is not a green report.
   */
  get result() {
    if (this.criteria.length === 0) return FAIL;
    if (this.criteria.some((c) => c.status === FAIL)) return FAIL;
    if (this.notExercised.length > 0) return INCOMPLETE;
    return PASS;
  }

  get ok() {
    return this.result === PASS;
  }

  /**
   * Built from what the run actually has rather than fixed by position: the M3 and M4 reports used
   * to rewrite two lines of a fixed header by string replacement, which silently ate a criterion
   * the day a row was added above.
   */
  headerLines() {
    const m = this.meta;
    const row = (label, value) => `  ${label.padEnd(17)}${value}`;
    const out = [m.title ?? "RFP Hub — deployment compliance check"];
    if (m.milestone) {
      out.push(
        row("Milestone", `${m.milestone.toUpperCase()} — contract criteria mapped to checks`),
      );
    }
    if (m.selection) out.push(row("Selection", m.selection));
    if (m.scopeLabel) out.push(row("Scope", m.scopeLabel));
    if (m.api) out.push(row("API", m.api));
    if (m.site) out.push(row("Site", m.site));
    if (m.exportUrl) out.push(row("Export root", m.exportUrl));
    if (m.namespace) out.push(row("Namespace", m.namespace));
    if (m.repoRoot) out.push(row("Repo root", m.repoRoot));
    out.push(row("Started", this.startedAt));
    return out;
  }

  toJSON() {
    const { title, milestone, scopeLabel, selection, contractIds, ...target } = this.meta;
    return {
      tool: "compliance",
      // `ok` stays a boolean for consumers that only ask "is this green"; `result` is the one that
      // distinguishes a run that failed from a run that never got to look.
      ok: this.ok,
      result: this.result,
      signOff: scopeLabel ? false : this.result === PASS,
      ...(milestone ? { milestone } : {}),
      ...(scopeLabel ? { scope: scopeLabel } : {}),
      startedAt: this.startedAt,
      finishedAt: new Date().toISOString(),
      target,
      summary: {
        criteria: this.criteria.length,
        failed: this.criteria.filter((c) => c.status === FAIL).length,
        notExercised: this.notExercised.length,
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
        ...(c.contractId === undefined ? {} : { contractId: c.contractId }),
        name: c.name,
        describes: c.describes,
        status: c.status,
        elapsedMs: c.elapsedMs,
        tally: c.tally(),
        ...(c.unmetChecks.length > 0 ? { unmet: c.unmetChecks } : {}),
        checks: c.checks,
      })),
    };
  }

  render({ color = false } = {}) {
    const esc = "\u001b[";
    const paint = (status, text) => (color ? `${esc}${COLOR[status]}m${text}${esc}0m` : text);
    const out = [...this.headerLines(), ""];

    for (const c of this.criteria) {
      const head = `[${heading(c)}] ${c.name}`;
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
        `  ${paint(c.status, c.status.toUpperCase().padEnd(10))}  [${heading(c)}] ${c.name.padEnd(26)} ${counts}`,
      );
    }
    out.push("");

    // The headline carries the skip counts even when the run passes. A legitimate skip inside an
    // exercised criterion — the loopback TLS probe — is green and should stay green, but a reader
    // signing this off is entitled to see that something was not looked at without opening the JSON.
    const result = this.result;
    const notes = [];
    const never = this.criteria.filter((c) => c.status === SKIP);
    const unmet = this.criteria.filter((c) => c.status === INCOMPLETE);
    if (never.length > 0) {
      notes.push(
        `${never.length} criterion(s) never exercised: ${never.map((c) => c.id).join(", ")}`,
      );
    }
    if (unmet.length > 0) {
      notes.push(
        `${unmet.length} criterion(s) with unmet requirements: ${unmet
          .map((c) => `${c.id} (${c.unmetChecks.join("; ")})`)
          .join(", ")}`,
      );
    }
    const skipped = this.skippedChecks;
    if (skipped > 0) notes.push(`${skipped} check(s) skipped`);

    const label = result === PASS ? "PASS" : result === FAIL ? "FAIL" : "INCOMPLETE";
    const headline = this.meta.scopeLabel
      ? `RESULT: SCOPED ${label} — ${this.meta.scopeLabel}`
      : `RESULT: ${label}`;
    out.push(
      paint(
        result === PASS ? PASS : result === FAIL ? FAIL : WARN,
        `${headline}${notes.length ? ` (${notes.join("; ")})` : ""}`,
      ),
    );
    return out.join("\n");
  }
}
