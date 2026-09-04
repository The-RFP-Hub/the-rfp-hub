// Assert, BEFORE `vercel build` runs, that the pulled environment names a canonical origin — or,
// for a preview, that it names none.
//
// `packages/frontend/src/lib/site-origin.ts` decides indexing from two facts: an explicit
// `NEXT_PUBLIC_SITE_ORIGIN`, or Vercel's own `VERCEL_ENV` + `VERCEL_PROJECT_PRODUCTION_URL`. Those
// two reach the build only while the project's "Automatically expose System Environment Variables"
// setting is on. It is on by default, but it is a setting, and turning it off costs production its
// search presence with no error anywhere: `robots.ts` and `sitemap.ts` are fail-closed by design,
// so the deploy is green and the site is `noindex`. This makes that failure loud instead.
//
// The file read is the one `vercel pull` wrote and `vercel build` feeds the build with, so this
// asserts on the actual build input rather than on the runner's own environment.
//
// Usage: node scripts/check-canonical-origin.mjs <env-file> [--expect origin|none]
// Exit: 0 the expectation held; 1 it did not; 2 the file is unreadable.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "./env-to-container-env.mjs";

export const EXPOSE_SETTING =
  'Vercel → Project → Settings → Environment Variables → "Automatically expose System Environment Variables"';

/**
 * The same decision `canonicalSiteOrigin()` makes, kept deliberately separate: this runs on a
 * runner with no bundler and no workspace install. The test file pins the frontend's own source
 * against it, so a rule that changes there fails here rather than drifting.
 */
export function resolveCanonicalOrigin(env) {
  const explicit = env.NEXT_PUBLIC_SITE_ORIGIN;
  if (explicit) {
    const origin = toOrigin(explicit);
    return origin
      ? { origin, source: "NEXT_PUBLIC_SITE_ORIGIN" }
      : {
          origin: null,
          reason: `NEXT_PUBLIC_SITE_ORIGIN is set to ${JSON.stringify(explicit)}, which is not a URL. It wins over Vercel's own variables, so nothing else is consulted.`,
        };
  }
  if (env.VERCEL_ENV !== "production") {
    return {
      origin: null,
      reason: env.VERCEL_ENV
        ? `VERCEL_ENV is ${JSON.stringify(env.VERCEL_ENV)}, not "production".`
        : `VERCEL_ENV is absent. Either ${EXPOSE_SETTING} is off, or this environment is not production.`,
    };
  }
  const host = env.VERCEL_PROJECT_PRODUCTION_URL;
  if (!host) {
    return {
      origin: null,
      reason: `VERCEL_ENV is "production" but VERCEL_PROJECT_PRODUCTION_URL is absent — check ${EXPOSE_SETTING}.`,
    };
  }
  const origin = toOrigin(`https://${host}`);
  return origin
    ? { origin, source: "VERCEL_PROJECT_PRODUCTION_URL" }
    : {
        origin: null,
        reason: `VERCEL_PROJECT_PRODUCTION_URL is ${JSON.stringify(host)}, which is not a host name.`,
      };
}

/** Which variables the pull carried, so the log says whether Vercel sent the one that is missing. */
export function pulledNames(env) {
  const names = Object.keys(env)
    .filter(
      (name) => name === "VERCEL" || name.startsWith("VERCEL_") || name.startsWith("NEXT_PUBLIC_"),
    )
    .sort();
  return names.length > 0 ? names.join(", ") : "(none of VERCEL*, NEXT_PUBLIC_*)";
}

function toOrigin(value) {
  try {
    const { origin } = new URL(value);
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
}

function main(argv) {
  let expect = "origin";
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--expect") expect = argv[++i];
    else positionals.push(argv[i]);
  }
  const path = positionals[0];
  if (!path || (expect !== "origin" && expect !== "none")) {
    console.error(
      "Usage: node scripts/check-canonical-origin.mjs <env-file> [--expect origin|none]",
    );
    process.exit(2);
  }

  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    console.error(`::error::cannot read ${path} — did \`vercel pull\` run? (${error.message})`);
    process.exit(2);
  }

  const env = parseEnv(text);
  const result = resolveCanonicalOrigin(env);

  if (expect === "none") {
    if (result.origin) {
      console.error(
        `::error::this environment claims ${result.origin} as its canonical origin (from ${result.source}), so the deployment would index itself and compete with production. Remove NEXT_PUBLIC_SITE_ORIGIN from it.`,
      );
      process.exit(1);
    }
    console.log(`canonical origin: none — ${result.reason} Fail-closed: noindex, Disallow: /`);
    return;
  }

  if (!result.origin) {
    console.error(
      `::error::this build would ship a production frontend that asks search engines not to index it. ${result.reason} Fix it by turning on ${EXPOSE_SETTING}, or by setting NEXT_PUBLIC_SITE_ORIGIN on the Production environment to this deployment's own public origin. The pulled file names: ${pulledNames(env)} (values withheld).`,
    );
    process.exit(1);
  }
  console.log(`canonical origin: ${result.origin} (from ${result.source})`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2));
}
