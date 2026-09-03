/**
 * The two registries, and the rules for selecting from them.
 *
 * A criterion is a module exporting `meta` and `run(ctx)`. The runner never switches on a key: it
 * walks an ordered array and calls `run`, so adding a criterion is adding a module and a line here.
 *
 * READ criteria may be pointed at anything, including production, because they only read. WRITE
 * criteria go in the other registry, behind the target guard, because there is no safe default for
 * a tool that submits entries. Nothing may appear in both.
 *
 * Imports are static and relative to THIS file. A registry that resolved module paths from a string
 * would resolve them against whichever entry point imported it, which is not this directory.
 */
import * as analytics from "./checks/analytics.mjs";
import * as audit from "./checks/audit.mjs";
import * as dataset from "./checks/dataset.mjs";
import * as duplicates from "./checks/duplicates.mjs";
import * as exportCheck from "./checks/export.mjs";
import * as lifecycle from "./checks/lifecycle.mjs";
import * as liveness from "./checks/liveness.mjs";
import * as namespaceCheck from "./checks/namespace.mjs";
import * as openapi from "./checks/openapi.mjs";
import * as staleness from "./checks/staleness.mjs";
import * as teardown from "./checks/teardown.mjs";
import * as verification from "./checks/verification.mjs";

/** Read-only criteria, in the order a full run performs them. */
export const READ_CRITERIA = [liveness, openapi, dataset, exportCheck];

/**
 * Criteria that WRITE, in the order a full run performs them. The order is load-bearing: lifecycle
 * creates the fixture the other six read. `teardown` is here so it can be looked up, but it is
 * never selectable — a write run appends it, last, in a `finally`.
 */
export const WRITE_CRITERIA = [
  lifecycle,
  namespaceCheck,
  audit,
  duplicates,
  verification,
  analytics,
  staleness,
  teardown,
];

export const TEARDOWN = teardown;

/** Which criteria a contract milestone maps to. Extended with `m4` when its criteria land. */
export const READ_MILESTONES = { m2: ["liveness", "openapi", "dataset", "export"] };

export const WRITE_MILESTONES = {
  m3: ["lifecycle", "namespace", "audit", "duplicates", "verification", "analytics", "staleness"],
};

/** Milestones the OTHER binary owns, so an error can say which tool to reach for. */
export const MILESTONE_TOOL = { m2: "read", m3: "write", m4: "read" };

const keyOf = (criterion) => criterion.meta.key;

export function criterionKeys(registry) {
  return registry.filter((criterion) => criterion !== teardown).map(keyOf);
}

export function findCriterion(registry, key) {
  return registry.find((criterion) => keyOf(criterion) === key);
}

/** The contract id a milestone maps a key to: a string, `null` for hygiene, `undefined` if unmapped. */
export function contractId(registry, key, milestone) {
  return findCriterion(registry, key)?.meta.contract?.[milestone];
}

/** `{ liveness: "M2-1", … }` for a milestone run — what the report stamps onto each criterion. */
export function contractIds(registry, milestone) {
  const ids = {};
  for (const criterion of registry) {
    const id = criterion.meta.contract?.[milestone];
    if (id !== undefined) ids[keyOf(criterion)] = id;
  }
  return ids;
}

/**
 * Which criteria this run registers, and what to say about the selection.
 *
 * A criterion excluded by `--only` is not registered at all, so a green scoped run is a clean pass
 * rather than a report full of holes. A HARD prerequisite of a selected criterion is pulled in
 * automatically and announced: `--only audit` without it produces a run whose single criterion can
 * only report that it had no fixture to read, which answers nothing.
 */
export function selectCriteria(registry, { only = new Set(), skip = new Set(), profile } = {}) {
  const selectable = registry.filter((criterion) => criterion !== teardown);
  const wanted = profile
    ? new Set(profile)
    : only.size > 0
      ? new Set(only)
      : new Set(selectable.map(keyOf));

  const autoIncluded = [];
  for (const criterion of selectable) {
    if (!wanted.has(keyOf(criterion))) continue;
    for (const requirement of criterion.meta.requires ?? []) {
      if (!requirement.hard || wanted.has(requirement.key)) continue;
      wanted.add(requirement.key);
      autoIncluded.push(requirement.key);
    }
  }

  return {
    criteria: selectable.filter(
      (criterion) => wanted.has(keyOf(criterion)) && !skip.has(keyOf(criterion)),
    ),
    skipped: selectable.filter(
      (criterion) => wanted.has(keyOf(criterion)) && skip.has(keyOf(criterion)),
    ),
    autoIncluded,
  };
}

/**
 * Why this selection cannot mean anything, or an empty list.
 *
 * Skipping a criterion another selected criterion depends on is refused rather than run: the
 * dependent would report an unmet requirement for a reason the operator chose, which reads as a
 * finding about the deployment and is not one.
 */
export function selectionRefusals(registry, { only = new Set(), skip = new Set() } = {}) {
  const reasons = [];
  if (only.size > 0 && skip.size > 0) {
    reasons.push("--only and --skip cannot be combined: --only already says what runs");
  }
  const known = new Set(criterionKeys(registry));
  for (const key of [...only, ...skip]) {
    if (!known.has(key)) {
      reasons.push(`unknown criterion "${key}" — known keys: ${[...known].join(", ")}`);
    }
  }
  if (reasons.length > 0) return reasons;

  const { criteria } = selectCriteria(registry, { only, skip: new Set() });
  for (const criterion of criteria) {
    for (const requirement of criterion.meta.requires ?? []) {
      if (requirement.hard && skip.has(requirement.key)) {
        reasons.push(
          `--skip ${requirement.key} cannot be combined with ${keyOf(criterion)}, which depends on it: the run would report an unmet requirement you asked for`,
        );
      }
    }
  }
  return reasons;
}
