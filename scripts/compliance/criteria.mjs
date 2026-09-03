// The two registries. Why they are two, and what --only/--skip mean: ./README.md.
// Imports stay static and relative to THIS file — a path resolved from a string would resolve
// against whichever entry point imported it, which is not this directory.
import * as submissionCycle from "./accept/submission-cycle.mjs";
import * as analytics from "./checks/analytics.mjs";
import * as audit from "./checks/audit.mjs";
import * as dataset from "./checks/dataset.mjs";
import * as docs from "./checks/docs.mjs";
import * as duplicates from "./checks/duplicates.mjs";
import * as exportCheck from "./checks/export.mjs";
import * as frontend from "./checks/frontend.mjs";
import * as governance from "./checks/governance.mjs";
import * as lifecycle from "./checks/lifecycle.mjs";
import * as liveness from "./checks/liveness.mjs";
import * as mcpPublication from "./checks/mcp-publication.mjs";
import * as mcp from "./checks/mcp.mjs";
import * as namespaceCheck from "./checks/namespace.mjs";
import * as openapi from "./checks/openapi.mjs";
import * as publishers from "./checks/publishers.mjs";
import * as skill from "./checks/skill.mjs";
import * as staleness from "./checks/staleness.mjs";
import * as teardown from "./checks/teardown.mjs";
import * as verification from "./checks/verification.mjs";

export const READ_CRITERIA = [
  liveness,
  openapi,
  dataset,
  exportCheck,
  governance,
  publishers,
  frontend,
  mcp,
  mcpPublication,
  skill,
  docs,
];

// Order is load-bearing: lifecycle creates the fixture the other six read. `teardown` is never
// selectable — a write run appends it, last, in a `finally`.
export const WRITE_CRITERIA = [
  lifecycle,
  namespaceCheck,
  audit,
  duplicates,
  verification,
  analytics,
  staleness,
  submissionCycle,
  teardown,
];

export const TEARDOWN = teardown;

export const READ_MILESTONES = {
  m2: ["liveness", "openapi", "dataset", "export"],
  m4: ["governance", "publishers", "frontend", "mcp", "mcp-publication", "skill", "docs"],
};

export const WRITE_MILESTONES = {
  m3: ["lifecycle", "namespace", "audit", "duplicates", "verification", "analytics", "staleness"],
  m4: ["submission-cycle"],
};

const keyOf = (criterion) => criterion.meta.key;

export function criterionKeys(registry) {
  return registry.filter((criterion) => criterion !== teardown).map(keyOf);
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

/** A HARD prerequisite is pulled in: `--only audit` alone could only report it had no fixture. */
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
 * Skipping a prerequisite of a selected criterion is refused: the dependent would report an unmet
 * requirement the operator chose, which reads as a finding about the deployment and is not one.
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
