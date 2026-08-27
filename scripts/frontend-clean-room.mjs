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
//   5. Requests `/`, `/publishers` and `/?q=<term>` against the running server and checks them.
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
// Usage:
//   node scripts/frontend-clean-room.mjs [--api-url <url>] [--port <n>] [--keep]
//
// Env (all optional):
//   NEXT_PUBLIC_API_URL     Same as --api-url. Default: https://api.ethrfps.app
//   RFPHUB_STANDARD_SPEC    See MODES above.
//   RFPHUB_VALIDATE_SPEC    See MODES above.
//   RFPHUB_CLEAN_ROOM_PORT  Same as --port. Default: an OS-assigned free port.
//
// Exit codes: 0 every check passed (a `/publishers` 404 is a WARNING, not a failure — the route
// may not exist yet in this checkout); 1 a check failed (a non-2xx/404 status, missing app shell,
// or the server never came up); 2 install or build itself failed.
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
  const out = { apiUrl: undefined, port: undefined, keep: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--api-url") out.apiUrl = argv[++i];
    else if (a === "--port") out.port = Number(argv[++i]);
    else if (a === "--keep") out.keep = true;
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

async function checkRoute(base, path, { label }) {
  const url = `${base}${path}`;
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  } catch (err) {
    return { path, label, ok: false, level: "fail", detail: `request failed: ${err.message}` };
  }
  const body = await res.text();
  if (res.status === 404) {
    return {
      path,
      label,
      ok: true,
      level: "warn",
      detail: "404 (route not present in this checkout yet — not a portability failure)",
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
      detail: `expected 200 or 404, got ${res.status}`,
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

  const tmpRoot = mkdtempSync(join(tmpdir(), "rfphub-frontend-clean-room-"));
  const appDir = join(tmpRoot, "frontend");
  let serverProcess;
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

    // 5. The three checks.
    const results = await Promise.all([
      checkRoute(base, "/", { label: "directory" }),
      checkRoute(base, "/publishers", { label: "publishers (may not exist yet in this checkout)" }),
      checkRoute(base, "/?q=grant", { label: "directory, filtered by search" }),
    ]);

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
