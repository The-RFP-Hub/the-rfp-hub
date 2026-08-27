/**
 * Playwright access for the checks that need a real DOM — the frontend is client-rendered, so a
 * plain `fetch` of `/` or `/publishers` sees an (almost) empty shell, not the rendered content the
 * criteria in §4.4 actually ask about.
 *
 * This checker does NOT depend on Playwright at the repo root — only `packages/e2e` does. Rather
 * than duplicate that dependency at the root (and have two versions to keep in sync), this module
 * resolves `@playwright/test` THROUGH `packages/e2e`'s own `node_modules`, via `createRequire`
 * anchored at that package's `package.json`. When it is not there — a checkout that never ran
 * `pnpm install` for that workspace member — every `--browser` check reports a named WARN rather
 * than crashing the whole run.
 */
import { createRequire } from "node:module";
import { join } from "node:path";

let cached;

/** Returns `{ chromium }` or `null` if Playwright cannot be resolved from this repo checkout. */
export function loadPlaywright(repoRoot) {
  if (cached !== undefined) return cached;
  try {
    const req = createRequire(join(repoRoot, "packages/e2e/package.json"));
    const pw = req("@playwright/test");
    cached = { chromium: pw.chromium };
  } catch {
    cached = null;
  }
  return cached;
}

export const PLAYWRIGHT_MISSING =
  "Playwright is not resolvable from packages/e2e — run `pnpm install` (or `pnpm --filter @the-rfp-hub/e2e install`) so `--browser` checks can launch Chromium.";

/**
 * Open a page, run `fn(page)`, and always close the browser — including when `fn` throws, so a
 * failed assertion inside one check never leaks a Chromium process into the next one.
 */
export async function withPage(repoRoot, fn) {
  const pw = loadPlaywright(repoRoot);
  if (!pw) throw new Error(PLAYWRIGHT_MISSING);
  const browser = await pw.chromium.launch();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    return await fn(page, context);
  } finally {
    await browser.close();
  }
}
