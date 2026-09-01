/**
 * Playwright for the checks that need a real DOM. Resolved THROUGH `packages/e2e`'s own
 * `node_modules` rather than added as a second root dependency with its own version to keep in
 * sync; when it is not there, `--browser` checks fail by name instead of crashing the run.
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
 *
 * `contextOptions` reaches `newContext` because a viewport alone is not a phone: `isMobile` is what
 * makes `(pointer: coarse)` match, and that is the media query the frontend's CSS uses to widen a
 * control to its touch target. Measuring without it reads a layout no real phone shows.
 */
export async function withPage(repoRoot, fn, contextOptions = {}) {
  const pw = loadPlaywright(repoRoot);
  if (!pw) throw new Error(PLAYWRIGHT_MISSING);
  const browser = await pw.chromium.launch();
  try {
    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();
    return await fn(page, context);
  } finally {
    await browser.close();
  }
}
