// Deploy hygiene: NO SECRET MAY ENTER THE CONTAINER IMAGE OR ITS LAYER CACHE.
//
// This repository is public, and the deploy workflows build with a `mode=max` buildx cache stored
// in this repository's own Actions cache. A secret that reaches a build layer is therefore
// readable by anyone who can pull the image AND by anyone who can read that cache. The fix was
// three edits — the Dockerfile stopped copying `.env`, `.dockerignore` started excluding it, and
// the workflow step that wrote Secrets Manager output into the build context was deleted — and
// each of them is a single line somebody could plausibly restore while debugging a deploy.
//
// So this check exists to make that restoration loud. It reads three things:
//
//   1. the Dockerfile — no `COPY` may name a `.env` file, and no `--env-file` flag may reintroduce
//      one at start-up (a flag pointing at a file that must not exist is a request for it to);
//   2. `.dockerignore` — the env patterns must all still be listed, so the file cannot reach the
//      build context at all even if a `COPY . .` is added later, and so must the deploy job's two
//      plaintext scratch names;
//   3. everything the runner executes — `.github/workflows/*.yml` AND `.github/scripts/**/*.sh` —
//      because a redirect that used to sit inline in a workflow reads exactly the same when it is
//      moved into a shell script the workflow calls, and a check that only reads YAML would not
//      see it.
//
// Configuration reaches the container through the ECS TASK DEFINITION instead: the deploy job
// reads Secrets Manager and writes the values into the definition it registers — interim into the
// container's `environment` array (scripts/env-to-container-env.mjs), eventually into its
// `secrets:` array. Neither is a build input, which is the only thing this file is about. See
// packages/api/docs/deploy.md for the variable→secret table, what the interim step exposes, and
// the rotation runbook.
//
// Run with `pnpm check:deploy`. Exits non-zero on any hit.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The patterns `.dockerignore` has to carry. Four env patterns rather than one because Docker's
 * ignore rules are path patterns, not globs that cross directories: `.env` alone excludes only the
 * repo-root file, and `**​/.env` alone excludes only the nested ones. `.env.*` covers
 * `.env.production` and friends, which are the same secret under a different name.
 *
 * The last two are the deploy job's plaintext scratch files — the ECS task definition it downloads
 * (which carries the PREVIOUS revision's environment) and the parsed pairs it renders from. Both
 * live under `$RUNNER_TEMP` today; these patterns are what keeps a copy left in the checkout root,
 * by a future edit or by an operator reproducing the deploy locally, out of the build context.
 */
export const REQUIRED_DOCKERIGNORE = [
  ".env",
  ".env.*",
  "**/.env",
  "**/.env.*",
  "task-definition*.json",
  "container-env*.json",
];

/**
 * A `COPY`/`ADD` instruction naming a `.env` file, in any of the forms one is written in:
 * `COPY .env* ./`, `COPY --chown=node:node ./.env /app/.env`, `ADD packages/api/.env .`.
 * Matched on the whole instruction line rather than anchored to `COPY .env`, because the flag and
 * path forms are exactly how the line comes back.
 */
const COPY_ENV = /^\s*(?:COPY|ADD)\b[^\n]*(?:^|[\s/])\.env/im;

/** `--env-file=…` / `--env-file-if-exists=…` — Node's flags for reading a dotenv file at start-up. */
const ENV_FILE_FLAG = /--env-file(?:-if-exists)?[=\s]/i;

/**
 * A shell redirect into a `.env` path: `> .env`, `>> ./.env`, `> packages/api/.env.production`.
 * This is the shape the deleted "Get .env from Secret Manager" step had, and the shape any
 * replacement would have — a secret fetched and written next to the Dockerfile.
 */
const REDIRECT_TO_ENV = />>?\s*(?:[^\s|;&]*\/)?\.env(?:\.[\w-]+)?\b/;

/** One finding. `file` is repo-relative; `line` is 1-based, or 0 for a whole-file rule. */
const finding = (file, line, message) => ({ file, line, message });

/** The Dockerfile must neither copy an env file into the image nor ask node to read one. */
export function scanDockerfile(text, file = "Dockerfile") {
  const out = [];
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    if (line.trimStart().startsWith("#")) return;
    if (COPY_ENV.test(line)) {
      out.push(
        finding(
          file,
          i + 1,
          `copies an env file into the image — every secret in it becomes readable from the image and from the build cache: ${line.trim()}`,
        ),
      );
    }
    if (ENV_FILE_FLAG.test(line)) {
      out.push(
        finding(
          file,
          i + 1,
          `reads a dotenv file at start-up, which only works if one was baked in: ${line.trim()}`,
        ),
      );
    }
  });
  return out;
}

/** `.dockerignore` must keep every required pattern, so no plaintext file can reach the build context. */
export function scanDockerignore(text, file = ".dockerignore") {
  const patterns = new Set(
    text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#")),
  );
  const out = [];
  const missing = REQUIRED_DOCKERIGNORE.filter((p) => !patterns.has(p));
  if (missing.length > 0) {
    out.push(
      finding(
        file,
        0,
        `missing the exclusion(s) ${missing.map((p) => `\`${p}\``).join(", ")} — without them a file holding plaintext configuration can enter the build context`,
      ),
    );
  }
  // Docker applies patterns in order and a later `!` re-includes: `!packages/api/.env` after the
  // env exclusions puts that file straight back into the context. Any negation that can name an
  // env file defeats them, so it is a finding regardless of where it sits.
  text.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (
      line.startsWith("!") &&
      /(^|\/)(\.env(\.|$|\*)|task-definition[^/]*\.json$|container-env[^/]*\.json$)/.test(
        line.slice(1),
      )
    ) {
      out.push(finding(file, i + 1, `re-includes an env file after the exclusions: ${line}`));
    }
  });
  return out;
}

/**
 * Nothing the runner executes may write a secret into a `.env` path in the build context — neither
 * a workflow's inline `run:` nor a shell script under `.github/scripts/` that a workflow calls.
 * Both are read as text, and both use `#` for comments, so one scanner covers them.
 */
export function scanRunnerSource(text, file) {
  const out = [];
  text.split("\n").forEach((line, i) => {
    if (line.trimStart().startsWith("#")) return;
    if (REDIRECT_TO_ENV.test(line)) {
      out.push(
        finding(
          file,
          i + 1,
          `writes into an env file in the build context: ${line.trim()}. Let the deploy job put the value in the ECS task definition instead (packages/api/docs/deploy.md).`,
        ),
      );
    }
  });
  return out;
}

const WORKFLOWS_DIR = ".github/workflows";
const RUNNER_SCRIPTS_DIR = ".github/scripts";

/**
 * Every file the runner executes: the workflows, plus the shell scripts they call. The scripts
 * directory is read recursively and tolerated absent — it is a convenience of the workflows, not a
 * required part of the tree.
 */
function runnerSources() {
  const list = (dir, test) => {
    try {
      return readdirSync(join(repoRoot, dir), { recursive: true })
        .map(String)
        .filter(test)
        .map((name) => `${dir}/${name}`);
    } catch {
      return [];
    }
  };
  return [
    ...list(WORKFLOWS_DIR, (f) => /\.ya?ml$/.test(f)),
    ...list(RUNNER_SCRIPTS_DIR, (f) => /\.sh$/.test(f)),
  ];
}

function main() {
  const read = (rel) => readFileSync(join(repoRoot, rel), "utf8");
  const sources = runnerSources();

  const failures = [
    ...scanDockerfile(read("Dockerfile")),
    ...scanDockerignore(read(".dockerignore")),
    ...sources.flatMap((rel) => scanRunnerSource(read(rel), rel)),
  ];

  if (failures.length > 0) {
    console.error(`✗ check-deploy: ${failures.length} way(s) a secret could reach the image`);
    for (const f of failures) {
      console.error(`  ${f.file}${f.line ? `:${f.line}` : ""}  ${f.message}`);
    }
    console.error(
      "\n  The image is not a secret store: it is pushed to a registry and cached, with `mode=max`,\n" +
        "  in a PUBLIC repository's Actions cache. Every runtime variable belongs in the ECS task\n" +
        "  definition, which the deploy job assembles from Secrets Manager — see\n" +
        "  packages/api/docs/deploy.md, which also carries the rotation runbook for values that were\n" +
        "  baked into earlier images.",
    );
    process.exit(1);
  }

  console.log(
    `✓ check-deploy: Dockerfile copies no env file, .dockerignore excludes ${REQUIRED_DOCKERIGNORE.join(", ")}, ` +
      `and none of the ${sources.length} workflow/runner script(s) writes one into the build context`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
