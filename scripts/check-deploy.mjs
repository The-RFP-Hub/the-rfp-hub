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
//      build context at all even if a `COPY . .` is added later;
//   3. `.github/workflows/*.yml` — nothing may write into a `.env` path in the build context.
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
 * The patterns `.dockerignore` has to carry. Four rather than one because Docker's ignore rules are
 * path patterns, not globs that cross directories: `.env` alone excludes only the repo-root file,
 * and `**​/.env` alone excludes only the nested ones. `.env.*` covers `.env.production` and friends,
 * which are the same secret under a different name.
 */
export const REQUIRED_DOCKERIGNORE = [".env", ".env.*", "**/.env", "**/.env.*"];

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

/** `.dockerignore` must keep every env pattern, so no env file can reach the build context. */
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
        `missing the env exclusion(s) ${missing.map((p) => `\`${p}\``).join(", ")} — without them an env file can enter the build context`,
      ),
    );
  }
  // Docker applies patterns in order and a later `!` re-includes: `!packages/api/.env` after the
  // four exclusions puts that file straight back into the context. Any negation that can name an
  // env file defeats the exclusions, so it is a finding regardless of where it sits.
  text.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (line.startsWith("!") && /(^|\/)\.env(\.|$|\*)/.test(line.slice(1))) {
      out.push(finding(file, i + 1, `re-includes an env file after the exclusions: ${line}`));
    }
  });
  return out;
}

/** No workflow may write a secret into a `.env` path in the build context. */
export function scanWorkflow(text, file) {
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

function main() {
  const read = (rel) => readFileSync(join(repoRoot, rel), "utf8");
  const workflows = readdirSync(join(repoRoot, WORKFLOWS_DIR)).filter((f) => /\.ya?ml$/.test(f));

  const failures = [
    ...scanDockerfile(read("Dockerfile")),
    ...scanDockerignore(read(".dockerignore")),
    ...workflows.flatMap((name) => {
      const rel = `${WORKFLOWS_DIR}/${name}`;
      return scanWorkflow(read(rel), rel);
    }),
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
      `and none of the ${workflows.length} workflow(s) writes one into the build context`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
