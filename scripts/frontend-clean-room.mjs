#!/usr/bin/env node
// The literal proof behind "clone ONLY packages/frontend and deploy it" — the contract's deploy
// path B (a copy of the package, not the monorepo). It is also `external-deploy-smoke.yml`'s (F3)
// engine: the workflow does nothing but invoke this script against a real API origin.
//
// What it does, mechanically:
//
//   1. Copies `packages/frontend` into a fresh temp directory — no `node_modules`, no `.next`,
//      nothing else in the workspace comes with it.
//   2. Rewrites its two `workspace:*` dependencies (`@the-rfp-hub/standard`, `rfphub-validate`) to
//      the specs this run was told to use — a semver range against the npm registry by default, or
//      a local tarball, per package, via env (see MODES below). A copy still carrying
//      `workspace:*` is not a clean-room copy: `workspace:*` means nothing to `npm install` outside
//      a pnpm workspace, and pretending otherwise would prove nothing about an external developer's
//      experience.
//   3. Runs `npm install` and the package's own `npm run build` — never `pnpm`, and never
//      `next build` invoked directly: the build script calls the LOCAL `next` binary, which after
//      a plain `npm install` only resolves through the npm-run path (`node_modules/.bin` on PATH),
//      not by name on the ambient shell.
//   4. STARTS the standalone server `next build`'s `output: "standalone"` writes, because a
//      directory existing on disk proves Next wrote *something*, not that the modules and assets
//      it needs at runtime were traced and packaged correctly — only a response proves that. See
//      "WHERE server.js LANDS" below for why this can't be a hard-coded path.
//   5. Requests `/`, `/publishers` and `/?q=<term>` against the running server — a FAST HTTP
//      pre-check that only reads server-rendered HTML (see "WHY A BROWSER TOO" below for why that
//      is not the whole proof).
//   6. With `--browser`, additionally drives a real headless Chromium through `/` and `/?q=<term>`
//      and waits for the client-side fetch to actually resolve into rendered rows or an error state.
//
// MODES — per-dependency, via environment variable, so CI can move one dependency at a time:
//
//   RFPHUB_STANDARD_SPEC   Default "^3.0.0" (published). Set to an absolute path ending in `.tgz`
//   RFPHUB_VALIDATE_SPEC   Default "^0.3.0" (published — see note below). Same tarball option.
//
// A tarball path is used as `file:<absolute path>` verbatim; anything else is used as-is, as a
// semver range against the npm registry.
//
// WHY `rfphub-validate` NEEDS THE TARBALL MODE TODAY: `packages/validate/src/index.ts` exports
// `humanizeIssues`, which `packages/frontend/src/lib/validate-client.ts` imports — but the
// published 0.3.0 tarball predates that export, so `RFPHUB_VALIDATE_SPEC=^0.3.0` (the default)
// fails this script's build step with TS2305 until 0.3.1 is published (see
// `.changeset/validate-humanize-issues-export.md`). Until then, point this script at a LOCAL
// tarball carrying the fix:
//
//   pnpm --filter rfphub-validate build
//   pnpm --filter rfphub-validate pack --pack-destination /tmp/rfphub-pack
//   RFPHUB_VALIDATE_SPEC=/tmp/rfphub-pack/rfphub-validate-0.3.0.tgz node scripts/frontend-clean-room.mjs
//
// `pnpm pack`, NOT `npm pack`. This matters and is easy to get backwards: `pnpm pack` rewrites the
// tarball's own `workspace:*` dependency on `@the-rfp-hub/standard` to the exact version in the
// workspace at pack time, which is what makes the tarball installable outside the monorepo at all.
// `npm pack` does not touch `workspace:*` — a tarball built with it still declares
// `"@the-rfp-hub/standard": "workspace:*"` in its own `package.json`, which `npm install` cannot
// resolve. (Verified empirically while building this script — the tarball's `package.json` is the
// place to check, not an assumption.) Once 0.3.1 is on the registry, drop the env var and both
// dependencies resolve from npm.
//
// WHERE server.js LANDS: `next.config.ts` sets `outputFileTracingRoot` to two directories above the
// package (the monorepo root, in place). A copy has no monorepo two levels up, but the option is
// unconditional, so Next still nests the standalone output under the path from THAT computed root
// to the package — in a copy this is some `<tmp>/.../frontend/server.js`, not the flat
// `.next/standalone/server.js` a from-scratch Next project would produce. This script does not
// hard-code the depth: it finds the one `server.js` under `.next/standalone` and treats its
// directory as the app root, which is also where `.next/static` (there is no `public/` directory in
// this package — nothing to copy there) has to be copied alongside it for the server to find its
// own assets.
//
// WHY A BROWSER TOO: `DirectoryList` (packages/frontend/src/components/DirectoryList.tsx) fetches
// its data from a `useEffect` AFTER hydration — the server-rendered HTML the plain HTTP check reads
// is the loading shell, not the data. A wrong or unreachable `NEXT_PUBLIC_API_URL`, a CORS
// rejection, or a CSP `connect-src` that blocks the request would all still leave that shell 200 and
// looking like the app — the HTTP check would pass on a build that cannot actually talk to its API.
// `--browser` closes that gap: it opens a real headless Chromium, watches the DOM for either a
// rendered opportunity row (`a.row-title` — `DirectoryRow`'s link) or the shared error state
// (`.state.error[role="alert"]` — `ErrorState`/`ResourceView` in `components/states.tsx`), and
// separately confirms a request actually reached `NEXT_PUBLIC_API_URL`'s own origin. Both selectors
// are read off those two files' own markup; if that markup changes, update the selectors here too.
// ONE ERROR STATE IS FILTERED OUT BY NAME: `/` also renders an independent sign-in/session card
// (`PublisherInvitation` in `src/app/page.tsx`) that calls the API's session endpoint directly,
// which `TRUSTED_ORIGINS` — an exact allowlist — refuses for any clean-room copy's ephemeral
// origin. That panel's `AuthUnavailable` state uses the SAME error markup as the directory's own
// and renders on every run against a real API, on its own schedule, regardless of whether the
// directory succeeded — so it is excluded by its own copy ("Sign-in is unavailable", unique to
// `AuthUnavailable`) rather than by which one appears first, since the two race independently.
//
// Usage:
//   node scripts/frontend-clean-room.mjs [--api-url <url>] [--port <n>] [--keep] [--browser]
//                                         [--require-publishers]
//
// Env (all optional):
//   NEXT_PUBLIC_API_URL     Same as --api-url. Default: https://api.ethrfps.app
//   RFPHUB_STANDARD_SPEC    See MODES above.
//   RFPHUB_VALIDATE_SPEC    See MODES above.
//   RFPHUB_CLEAN_ROOM_PORT  Same as --port. Default: an OS-assigned free port.
//   REQUIRE_PUBLISHERS      Same as --require-publishers when "1" or "true". Default: unset — a
//                           `/publishers` 404 is a WARNING (the route may not exist in this
//                           checkout yet). Flip once that route ships so its regression is a FAILURE.
//
// `--browser` is a fast-check OPT-IN here (Playwright is a real dependency to spin up), but
// `external-deploy-smoke.yml` always passes it — the HTTP-only run is a quick local smoke test, not
// the full proof this criterion needs.
//
// Exit codes: 0 every check passed; 1 a check failed (wrong status, missing app shell, a client-side
// error state, a required route missing, or the server never came up); 2 install or build itself
// failed.
import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const frontendSrc = join(repoRoot, "packages", "frontend");

function parseArgs(argv) {
  const out = {
    apiUrl: undefined,
    port: undefined,
    keep: false,
    browser: false,
    requirePublishers: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--api-url") out.apiUrl = argv[++i];
    else if (a === "--port") out.port = Number(argv[++i]);
    else if (a === "--keep") out.keep = true;
    else if (a === "--browser") out.browser = true;
    else if (a === "--require-publishers") out.requirePublishers = true;
    else if (a === "--help" || a === "-h") {
      console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\nimport")[0]);
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

function truthyEnv(value) {
  return /^(1|true)$/i.test(value ?? "");
}

/** A dependency spec that names a `.tgz` file becomes `file:<absolute path>`; anything else passes through as a registry range. */
function resolveSpec(spec) {
  if (spec.endsWith(".tgz")) return `file:${resolve(spec)}`;
  return spec;
}

/** An OS-assigned free TCP port, so two runs never collide on a busy CI runner or a developer's laptop. */
function freePort() {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolvePort(port));
    });
  });
}

/** Depth-first search for a file named `server.js` under `dir`. There must be exactly one — the app's own. */
function findServerJs(dir) {
  const found = [];
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue; // traced deps can be deep; never the app's own server.js
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name === "server.js") found.push(p);
    }
  };
  walk(dir);
  return found;
}

function run(cmd, args, opts) {
  const result = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (result.status !== 0) {
    throw new Error(
      `${cmd} ${args.join(" ")} exited ${result.status ?? `signal ${result.signal}`}`,
    );
  }
}

async function waitUntilUp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok || res.status === 404) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`server never answered ${url} within ${timeoutMs}ms`);
}

/** The one thing every one of these responses is asserted to be: this app's own shell, not an error page or someone else's server. */
function looksLikeAppShell(html) {
  return /<title>[^<]*RFP Hub[^<]*<\/title>/i.test(html) || /RFP Hub/i.test(html);
}

/**
 * The fast HTTP pre-check: status and server-rendered shell only. `allow404` is per-route — only
 * `/publishers` (and only until `REQUIRE_PUBLISHERS` says otherwise) may be missing without failing
 * the run; `/` and a filtered `/` are the contract's own minimum and a 404 on either is a failure,
 * not a warning.
 */
async function checkRoute(base, path, { label, allow404 }) {
  const url = `${base}${path}`;
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  } catch (err) {
    return { path, label, ok: false, level: "fail", detail: `request failed: ${err.message}` };
  }
  const body = await res.text();
  if (res.status === 404) {
    if (allow404) {
      return {
        path,
        label,
        ok: true,
        level: "warn",
        detail: "404 (route not present in this checkout yet — not a portability failure)",
      };
    }
    return {
      path,
      label,
      ok: false,
      level: "fail",
      detail: "404, but this route is required (not eligible for the 404 allowance)",
    };
  }
  if (res.status >= 500) {
    return { path, label, ok: false, level: "fail", detail: `${res.status} ${res.statusText}` };
  }
  if (res.status !== 200) {
    return {
      path,
      label,
      ok: false,
      level: "fail",
      detail: `expected 200${allow404 ? " or 404" : ""}, got ${res.status}`,
    };
  }
  if (!looksLikeAppShell(body)) {
    return {
      path,
      label,
      ok: false,
      level: "fail",
      detail: "200 but body does not look like this app's shell",
    };
  }
  return { path, label, ok: true, level: "pass", detail: "200, app shell present" };
}

/**
 * The browser-driven check. See "WHY A BROWSER TOO" at the top of this file for what this catches
 * that `checkRoute` cannot: a client-side fetch that never reaches, or never returns from, the
 * configured API origin.
 *
 * Waits for the DOM to reach one of two states — at least one rendered opportunity row, or the
 * shared error callout — and separately asserts a request actually reached
 * `NEXT_PUBLIC_API_URL`'s own origin at `/v1/opportunities*`. A CORS rejection or a CSP-blocked
 * fetch both surface as the error callout (the client's fetch wrapper turns any unreachable-API
 * failure into the same `ApiError`), so that branch alone already catches most of what a browser is
 * for here; the origin check on top of it catches a fetch that quietly went to the SSR shell's own
 * origin instead of the configured API, which would look identical if it happened to still error.
 *
 * Neither state appearing within the timeout — a stuck loading spinner, or a legitimately empty
 * result set for a search term this script did not choose at random — is reported as a failure
 * rather than silently accepted: this script chose "grant" because the production corpus is known
 * to have matches for it, so an empty result here means something is wrong, not that the search
 * genuinely found nothing.
 */
async function checkRouteInBrowser(browser, base, apiUrl, path, { label }) {
  const apiOrigin = new URL(apiUrl).origin;
  const context = await browser.newContext();
  const page = await context.newPage();
  const apiRequests = [];
  page.on("request", (req) => {
    try {
      const u = new URL(req.url());
      if (u.origin === apiOrigin && u.pathname.startsWith("/v1/opportunities")) {
        apiRequests.push(req.url());
      }
    } catch {
      // not a URL worth tracking
    }
  });

  try {
    await page.goto(`${base}${path}`, { waitUntil: "domcontentloaded", timeout: 15_000 });

    let outcome;
    try {
      const handle = await page.waitForFunction(
        () => {
          // `/` renders DirectoryList AND, below it, a sign-in/session card
          // (`PublisherInvitation` in `src/app/page.tsx`) that calls the API's OWN session
          // endpoint directly. That endpoint is gated by `TRUSTED_ORIGINS` — an exact allowlist an
          // ephemeral clean-room origin is never on — so its `AuthUnavailable` panel is EXPECTED to
          // render the same `.state.error[role="alert"]` markup used here on EVERY run, on its own
          // schedule, regardless of whether the directory succeeds. It is filtered out by its own
          // copy (`"Sign-in is unavailable"`, unique to `AuthUnavailable` in
          // `components/states.tsx`) rather than by poll ordering: the session check and the
          // opportunities fetch race independently, so a poll tick can see the auth panel's error
          // rendered before the directory's own rows have — ignoring it only on the FIRST tick
          // would still misreport a slower-loading directory as failed.
          const items = document.querySelectorAll("a.row-title").length;
          if (items > 0) return { kind: "items", count: items };
          const errors = Array.from(document.querySelectorAll(".state.error[role='alert']"));
          const directoryError = errors.find(
            (el) => !(el.textContent ?? "").includes("Sign-in is unavailable"),
          );
          if (directoryError) {
            return { kind: "error", text: (directoryError.textContent ?? "").trim().slice(0, 300) };
          }
          return false;
        },
        undefined,
        { timeout: 20_000, polling: 250 },
      );
      outcome = await handle.jsonValue();
    } catch {
      return {
        path,
        label,
        ok: false,
        level: "fail",
        detail:
          "timed out waiting for a rendered opportunity row or an error state — the client-side fetch may be stuck or silently blocked",
      };
    }

    if (outcome.kind === "error") {
      return {
        path,
        label,
        ok: false,
        level: "fail",
        detail: `client rendered an error state: "${outcome.text}"`,
      };
    }

    if (apiRequests.length === 0) {
      return {
        path,
        label,
        ok: false,
        level: "fail",
        detail: `${outcome.count} item(s) rendered, but no request to ${apiOrigin}/v1/opportunities* was observed`,
      };
    }

    return {
      path,
      label,
      ok: true,
      level: "pass",
      detail: `${outcome.count} item(s) rendered, from a request to ${apiOrigin}`,
    };
  } catch (err) {
    return { path, label, ok: false, level: "fail", detail: `navigation failed: ${err.message}` };
  } finally {
    await context.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const apiUrl = args.apiUrl ?? process.env.NEXT_PUBLIC_API_URL ?? "https://api.ethrfps.app";
  const standardSpec = resolveSpec(process.env.RFPHUB_STANDARD_SPEC ?? "^3.0.0");
  const validateSpec = resolveSpec(process.env.RFPHUB_VALIDATE_SPEC ?? "^0.3.0");
  const port =
    args.port ??
    (process.env.RFPHUB_CLEAN_ROOM_PORT
      ? Number(process.env.RFPHUB_CLEAN_ROOM_PORT)
      : await freePort());
  const requirePublishers = args.requirePublishers || truthyEnv(process.env.REQUIRE_PUBLISHERS);

  console.log("frontend-clean-room: copying packages/frontend, then building against");
  console.log(`  @the-rfp-hub/standard -> ${standardSpec}`);
  console.log(`  rfphub-validate       -> ${validateSpec}`);
  console.log(`  NEXT_PUBLIC_API_URL   -> ${apiUrl}`);
  console.log(`  browser checks        -> ${args.browser ? "on" : "off (HTTP pre-check only)"}`);
  console.log(`  /publishers required  -> ${requirePublishers}`);

  const tmpRoot = mkdtempSync(join(tmpdir(), "rfphub-frontend-clean-room-"));
  const appDir = join(tmpRoot, "frontend");
  let serverProcess;
  let browserHandle;
  let exitCode = 0;

  try {
    // 1. Copy — everything except the two directories a clean checkout would never have anyway.
    cpSync(frontendSrc, appDir, {
      recursive: true,
      filter: (src) => !/[\\/](node_modules|\.next)(?:[\\/]|$)/.test(src),
    });

    // 2. Rewrite the two workspace dependencies.
    const pkgPath = join(appDir, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    pkg.dependencies["@the-rfp-hub/standard"] = standardSpec;
    pkg.dependencies["rfphub-validate"] = validateSpec;
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

    // 3. Install and build — npm, and the package's own `build` script, exactly like an external
    // developer with no pnpm workspace would run it.
    console.log("\n$ npm install");
    run("npm", ["install", "--no-audit", "--no-fund"], { cwd: appDir });

    console.log("\n$ npm run build");
    run("npm", ["run", "build"], {
      cwd: appDir,
      env: { ...process.env, NEXT_PUBLIC_API_URL: apiUrl },
    });

    // 4. Start the standalone server it produced.
    const standaloneDir = join(appDir, ".next", "standalone");
    let serverJsCandidates;
    try {
      serverJsCandidates = findServerJs(standaloneDir);
    } catch (err) {
      throw new Error(`could not read ${standaloneDir}: ${err.message}`);
    }
    if (serverJsCandidates.length !== 1) {
      throw new Error(
        `expected exactly one server.js under .next/standalone, found ${serverJsCandidates.length}: ${serverJsCandidates.join(", ")}`,
      );
    }
    const serverJs = serverJsCandidates[0];
    const serverDir = dirname(serverJs);

    // `.next/static` is not copied by `next build` into the standalone output — Next's own docs
    // say so, because not every deployment needs it colocated. This one does: the standalone
    // server serves it from `<its own dir>/.next/static`. There is no `public/` in this package,
    // so nothing else to copy.
    mkdirSync(join(serverDir, ".next"), { recursive: true });
    cpSync(join(appDir, ".next", "static"), join(serverDir, ".next", "static"), {
      recursive: true,
    });

    console.log(`\n$ node ${serverJs.replace(`${tmpRoot}/`, "")}  (port ${port})`);
    serverProcess = spawn(process.execPath, [serverJs], {
      cwd: serverDir,
      env: { ...process.env, PORT: String(port), HOSTNAME: "127.0.0.1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let serverOutput = "";
    serverProcess.stdout.on("data", (d) => {
      serverOutput += d;
    });
    serverProcess.stderr.on("data", (d) => {
      serverOutput += d;
    });
    serverProcess.on("exit", (code, signal) => {
      if (code !== null && code !== 0) {
        console.error(`server.js exited early with code ${code} (signal ${signal ?? "none"})`);
        console.error(serverOutput);
      }
    });

    const base = `http://127.0.0.1:${port}`;
    await waitUntilUp(`${base}/`, 20_000);

    // 5. The fast HTTP pre-check. `/` and the filtered `/` are required; `/publishers` may 404
    // unless REQUIRE_PUBLISHERS says otherwise.
    const results = await Promise.all([
      checkRoute(base, "/", { label: "directory", allow404: false }),
      checkRoute(base, "/publishers", {
        label: "publishers (may not exist yet in this checkout, unless required)",
        allow404: !requirePublishers,
      }),
      checkRoute(base, "/?q=grant", { label: "directory, filtered by search", allow404: false }),
    ]);

    // 6. The browser-driven check — opt-in here, always on in external-deploy-smoke.yml.
    if (args.browser) {
      const { chromium } = await import("@playwright/test");
      browserHandle = await chromium.launch();
      const browserResults = await Promise.all([
        checkRouteInBrowser(browserHandle, base, apiUrl, "/", {
          label: "directory, rendered from a real request",
        }),
        checkRouteInBrowser(browserHandle, base, apiUrl, "/?q=grant", {
          label: "directory filtered by search, rendered from a real request",
        }),
      ]);
      results.push(...browserResults);
    }

    console.log("\nResults:");
    for (const r of results) {
      const icon = r.level === "pass" ? "PASS" : r.level === "warn" ? "WARN" : "FAIL";
      console.log(`  [${icon}] ${r.path.padEnd(16)} ${r.label} — ${r.detail}`);
      if (!r.ok) exitCode = 1;
    }
  } catch (err) {
    console.error(`\nfrontend-clean-room FAILED: ${err.message}`);
    exitCode = exitCode || 2;
  } finally {
    if (browserHandle) await browserHandle.close().catch(() => {});
    if (serverProcess && !serverProcess.killed) serverProcess.kill();
    if (args.keep) {
      console.log(`\n--keep set: leaving ${tmpRoot} in place for inspection.`);
    } else {
      try {
        rmSync(tmpRoot, { recursive: true, force: true });
      } catch {
        // best-effort; a leftover temp dir is not a reason to fail the run
      }
    }
  }

  console.log(
    exitCode === 0 ? "\nfrontend-clean-room: OK" : `\nfrontend-clean-room: exiting ${exitCode}`,
  );
  process.exit(exitCode);
}

main();
