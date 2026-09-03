/**
 * Playwright's configuration for the M3 end-to-end suite.
 *
 * THE STACK IS NOT STARTED HERE. There is no `webServer` block: a disposable Postgres, a restricted
 * database role, an API, a frontend, a fixture web server and an identity preflight are more than
 * `webServer` can express, and — decisively — Playwright cannot guarantee teardown of resources it
 * did not create. `packages/e2e/src/run.ts` owns all of it in a `try/finally` and runs Playwright as
 * its child. So this file reads the state that runner wrote, and refuses to run without it.
 *
 * TWO SETTINGS ARE LOAD-BEARING AND ARE NOT PREFERENCES:
 *
 *   `workers: 1`  — several criteria are about ordering and about counters (audit chains, analytics
 *                   totals, the 25-key limit). Parallel workers writing into one database would make
 *                   those assertions race each other rather than the product.
 *   `retries: 0`  — a flaky SECURITY assertion retried into green is a security assertion that has
 *                   been deleted. If a negative test is unstable, that instability is the finding.
 *
 * AND SO IS THE ORDER THE SPEC FILES RUN IN. With one worker, Playwright runs them in the
 * alphabetical order of their paths, and several of them depend on that: the review queue's pending
 * cap is accounted for across files, and the fixture web server records only its LAST request. Every
 * file therefore carries a numeric prefix, so the order is stated rather than emergent — renaming a
 * spec must keep its number, or it moves in the run and the coupling surfaces as an unrelated 409.
 */
import { defineConfig, devices } from "@playwright/test";
import { readState } from "./src/state.js";

const state = readState();

/**
 * A headless-Chrome user agent, used by exactly one project.
 *
 * `analytics-hash.ts` excludes bot user agents from every counter, and "HeadlessChrome" is on that
 * list. The default UA of a headless Chromium therefore would NOT be counted — which means the
 * ordinary analytics criteria have to run with a real desktop UA (the `chromium` project below),
 * and the bot-exclusion criterion has to run with the headless one. Two projects, and a `grep`
 * pair, because without the grep pair every spec would run twice.
 */
const BOT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/131.0.0.0 Safari/537.36";
const DESKTOP_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export default defineConfig({
  testDir: "./tests",
  outputDir: "./test-results",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  // 2 s for the analytics buffer to flush, plus headroom for a first-compile Next route.
  expect: { timeout: 20_000 },
  forbidOnly: true,

  reporter: [
    ["list"],
    ["html", { outputFolder: "./playwright-report", open: "never" }],
    ["./src/reporter.ts"],
  ],

  use: {
    baseURL: state.urls.frontend,
    // Kept on failure only. Traces record request headers and Playwright offers no redaction hook,
    // so a failure trace CAN contain a short-lived access token — stated as known residue in the
    // README and the report, and the reason the end-of-run scan is scoped to long-lived secrets.
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },

  projects: [
    {
      // Every real-identity assertion the rest of the run depends on, in one observable place.
      name: "setup",
      testMatch: /00-acceptance\.setup\.ts$/,
      use: { ...devices["Desktop Chrome"], userAgent: DESKTOP_UA },
    },
    {
      name: "chromium",
      testIgnore: /00-acceptance\.setup\.ts$/,
      grepInvert: /@bot-ua/,
      dependencies: ["setup"],
      use: {
        ...devices["Desktop Chrome"],
        userAgent: DESKTOP_UA,
        storageState: state.storageStatePath,
      },
    },
    {
      name: "bot-ua",
      testIgnore: /00-acceptance\.setup\.ts$/,
      grep: /@bot-ua/,
      dependencies: ["setup"],
      use: {
        ...devices["Desktop Chrome"],
        userAgent: BOT_UA,
        storageState: state.storageStatePath,
      },
    },
  ],
});
