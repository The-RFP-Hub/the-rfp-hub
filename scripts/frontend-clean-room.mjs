#!/usr/bin/env node
// Deploy path B, proven mechanically: copy ONLY packages/frontend into a temp directory, rewrite its
// two workspace dependencies to installable specs, `npm install && npm run build`, start the
// standalone server and request `/`, `/publishers`, `/?q=…` and the `public/` assets against it.
// Also the engine behind the `clean-room` job in .github/workflows/ci.yml. The deploy paths:
// packages/frontend/README.md.
//
// Usage: node scripts/frontend-clean-room.mjs [--api-url <url>] [--port <n>] [--keep] [--browser]
//                                             [--require-publishers]
// Env: NEXT_PUBLIC_API_URL, RFPHUB_CLEAN_ROOM_PORT, REQUIRE_PUBLISHERS (= --require-publishers),
//   RFPHUB_STANDARD_SPEC / RFPHUB_VALIDATE_SPEC — a registry range, or an absolute .tgz path used
//   as `file:`. Build such a tarball with `pnpm pack`, NEVER `npm pack`: only pnpm rewrites the
//   tarball's own `workspace:*` dependency, and `npm install` cannot resolve what `npm pack` leaves.
//   rfphub-validate needs one until 0.3.1 publishes `humanizeIssues`, which the frontend imports.
//
// Exit: 0 every check passed; 1 a check failed; 2 install or build itself failed.
import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
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

function resolveSpec(spec) {
  if (spec.endsWith(".tgz")) return `file:${resolve(spec)}`;
  return spec;
}

// `PORT=0` on the Next standalone server does NOT ask the OS for an ephemeral port — verified
// empirically, it falls back to 3000 — so the port is probed here instead. The window between this
// probe closing and the server binding stays open, which is why the caller also watches for an
// early exit.
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

function findServerJs(dir) {
  const found = [];
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
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

// `checkAborted()` runs first on every tick: polling alone cannot tell "our server is slow" apart
// from "our server is dead and something else now answers on its port".
async function waitUntilUp(url, timeoutMs, checkAborted) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const abortError = checkAborted?.();
    if (abortError) throw abortError;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok || res.status === 404) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  const abortError = checkAborted?.();
  if (abortError) throw abortError;
  throw new Error(`server never answered ${url} within ${timeoutMs}ms`);
}

function looksLikeAppShell(html) {
  return /<title>[^<]*RFP Hub[^<]*<\/title>/i.test(html) || /RFP Hub/i.test(html);
}

/** Status and server-rendered shell only. `allow404` is per-route; `/` and a filtered `/` never get it. */
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
        detail: "404 (route not present in this checkout — not a portability failure)",
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

// `src/app/manifest.ts` names three of these icons, so a standalone output missing `public/` serves
// a manifest whose icons all 404 — invisible to any check that only looks at HTML routes.
async function checkPublicAssets(base, publicDir) {
  const label = "public/ assets served from the standalone output";
  const path = "/<public>";
  if (!existsSync(publicDir)) {
    return { path, label, ok: true, level: "warn", detail: "this copy ships no public/ directory" };
  }
  const names = readdirSync(publicDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
  if (names.length === 0) {
    return { path, label, ok: true, level: "warn", detail: "public/ is empty" };
  }
  for (const name of names) {
    let res;
    try {
      res = await fetch(`${base}/${name}`, { signal: AbortSignal.timeout(10_000) });
    } catch (err) {
      return { path, label, ok: false, level: "fail", detail: `/${name}: ${err.message}` };
    }
    const bytes = (await res.arrayBuffer()).byteLength;
    if (res.status !== 200) {
      return { path, label, ok: false, level: "fail", detail: `/${name}: got ${res.status}` };
    }
    if ((res.headers.get("content-type") ?? "").startsWith("text/html")) {
      return {
        path,
        label,
        ok: false,
        level: "fail",
        detail: `/${name}: served HTML, so the server answered with a page, not the asset`,
      };
    }
    if (bytes === 0) {
      return { path, label, ok: false, level: "fail", detail: `/${name}: 200 but empty` };
    }
  }
  return {
    path,
    label,
    ok: true,
    level: "pass",
    detail: `${names.length} served: ${names.join(", ")}`,
  };
}

/**
 * The only check that proves the app talks to its API: `DirectoryList` fetches after hydration, so a
 * wrong `NEXT_PUBLIC_API_URL`, a CORS rejection or a blocked `connect-src` all still leave the HTML
 * the HTTP check reads a 200 shell. Selectors are read off `DirectoryList.tsx` and `states.tsx`.
 *
 * `/` also renders a sign-in card whose `AuthUnavailable` state uses the SAME error markup and is
 * EXPECTED on every clean-room run (`TRUSTED_ORIGINS` is an exact allowlist), so it is excluded by
 * its own copy rather than by poll order: the two fetches race independently.
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
          const rows = Array.from(document.querySelectorAll("tbody a.row-title")).map(
            (a) => a.getAttribute("href") ?? "",
          );
          if (rows.length > 0) {
            const line = document.querySelector(".result-line")?.textContent ?? "";
            const pages = /page\s+\d+\s+of\s+(\d+)/i.exec(line);
            const total = /^([\d,]+)/.exec(
              (document.querySelector(".result-line strong")?.textContent ?? "").trim(),
            );
            return {
              kind: "items",
              rows,
              pages: pages ? Number(pages[1]) : 1,
              total: total ? Number(total[1].replace(/,/g, "")) : null,
            };
          }
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
        detail: `${outcome.rows.length} item(s) rendered, but no request to ${apiOrigin}/v1/opportunities* was observed`,
      };
    }

    return {
      path,
      label,
      ok: true,
      level: "pass",
      rows: outcome.rows,
      pages: outcome.pages,
      total: outcome.total,
      detail: `${outcome.rows.length} item(s) rendered, from a request to ${apiOrigin}`,
    };
  } catch (err) {
    return { path, label, ok: false, level: "fail", detail: `navigation failed: ${err.message}` };
  } finally {
    await context.close();
  }
}

// A search that returns the whole directory is a filter the copy is not applying. The ids alone are
// not enough: a working filter whose every match happens to be on page one returns the SAME first
// page and differs only in the totals, so a narrowed total or page count is just as good a proof.
function checkSearchNarrows(all, filtered) {
  const path = "/?q= vs /";
  const label = "the search term changes the result set";
  if (!all.rows || !filtered.rows) {
    return {
      path,
      label,
      ok: false,
      level: "fail",
      detail: "one of the two pages rendered no rows",
    };
  }
  const key = (rows) => [...rows].sort().join("\n");
  if (key(all.rows) !== key(filtered.rows)) {
    return {
      path,
      label,
      ok: true,
      level: "pass",
      detail: `${all.rows.length} unfiltered vs ${filtered.rows.length} filtered, different ids`,
    };
  }
  const counts = (r) => `${r.total ?? "?"} in ${r.pages ?? 1} page(s)`;
  if (all.total !== filtered.total || all.pages !== filtered.pages) {
    return {
      path,
      label,
      ok: true,
      level: "pass",
      detail: `same first page, but ${counts(all)} unfiltered vs ${counts(filtered)} filtered`,
    };
  }
  if ((all.pages ?? 1) > 1) {
    return {
      path,
      label,
      ok: false,
      level: "fail",
      detail: `identical ids and identical totals (${counts(all)}) — the search parameter is not reaching the API`,
    };
  }
  return {
    path,
    label,
    ok: true,
    level: "warn",
    detail: `identical ids and totals (${counts(all)}), but the whole corpus fits one page`,
  };
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

  console.log("frontend-clean-room: copying packages/frontend, then building against");
  console.log(`  @the-rfp-hub/standard -> ${standardSpec}`);
  console.log(`  rfphub-validate       -> ${validateSpec}`);
  console.log(`  NEXT_PUBLIC_API_URL   -> ${apiUrl}`);
  console.log(`  browser checks        -> ${args.browser ? "on" : "off (HTTP pre-check only)"}`);

  const tmpRoot = mkdtempSync(join(tmpdir(), "rfphub-frontend-clean-room-"));
  const appDir = join(tmpRoot, "frontend");
  let serverProcess;
  let browserHandle;
  let exitCode = 0;

  try {
    // A gitignored `.env*.local` is a developer's own machine leaking into the clean room.
    cpSync(frontendSrc, appDir, {
      recursive: true,
      filter: (src) =>
        !/[\\/](node_modules|\.next)(?:[\\/]|$)/.test(src) &&
        !/[\\/]\.env(\..*)?\.local$/.test(src),
    });

    // What the copy ships decides whether /publishers must answer; the flag can only add the
    // requirement, never drop it, so no CI input can quietly turn this assertion into a warning.
    const requirePublishers =
      args.requirePublishers ||
      truthyEnv(process.env.REQUIRE_PUBLISHERS) ||
      existsSync(join(appDir, "src", "app", "publishers"));
    console.log(`  /publishers required  -> ${requirePublishers}`);

    const pkgPath = join(appDir, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    pkg.dependencies["@the-rfp-hub/standard"] = standardSpec;
    pkg.dependencies["rfphub-validate"] = validateSpec;
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

    // The package's own `build` script, never `next build` directly: after a plain `npm install`
    // that binary resolves only through the npm-run PATH.
    console.log("\n$ npm install");
    run("npm", ["install", "--no-audit", "--no-fund"], { cwd: appDir });

    console.log("\n$ npm run build");
    run("npm", ["run", "build"], {
      cwd: appDir,
      env: { ...process.env, NEXT_PUBLIC_API_URL: apiUrl },
    });

    // `outputFileTracingRoot` is two directories above the package, so a copy's standalone output
    // stays nested under the path from that computed root — the depth is found, never assumed.
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

    // `next build` leaves `.next/static` and `public/` out of the standalone output on purpose; the
    // standalone server serves both from its OWN directory, so a deployment has to place them.
    mkdirSync(join(serverDir, ".next"), { recursive: true });
    cpSync(join(appDir, ".next", "static"), join(serverDir, ".next", "static"), {
      recursive: true,
    });
    const publicDir = join(appDir, "public");
    if (existsSync(publicDir)) {
      cpSync(publicDir, join(serverDir, "public"), { recursive: true });
    }

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
    // Armed only until `confirmedUp`: a later exit is this script's own teardown.
    let confirmedUp = false;
    let startupFailure = null;
    serverProcess.on("exit", (code, signal) => {
      if (code !== null && code !== 0) {
        console.error(`server.js exited early with code ${code} (signal ${signal ?? "none"})`);
        console.error(serverOutput);
      }
      if (!confirmedUp) {
        startupFailure = new Error(
          `server.js exited (code ${code ?? "null"}, signal ${signal ?? "none"}) before it ever answered a request — a likely port collision (EADDRINUSE) or a crash on startup; see the output above`,
        );
      }
    });

    const base = `http://127.0.0.1:${port}`;
    await waitUntilUp(`${base}/`, 20_000, () => startupFailure);
    confirmedUp = true;

    const results = await Promise.all([
      checkRoute(base, "/", { label: "directory", allow404: false }),
      checkRoute(base, "/publishers", {
        label: requirePublishers ? "publishers" : "publishers (absent from this copy)",
        allow404: !requirePublishers,
      }),
      checkRoute(base, "/?q=grant", { label: "directory, filtered by search", allow404: false }),
      checkPublicAssets(base, publicDir),
    ]);

    if (args.browser) {
      const { chromium } = await import("@playwright/test");
      browserHandle = await chromium.launch();
      const [all, filtered] = await Promise.all([
        checkRouteInBrowser(browserHandle, base, apiUrl, "/", {
          label: "directory, rendered from a real request",
        }),
        checkRouteInBrowser(browserHandle, base, apiUrl, "/?q=grant", {
          label: "directory filtered by search, rendered from a real request",
        }),
      ]);
      results.push(all, filtered, checkSearchNarrows(all, filtered));
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
