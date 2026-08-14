import { configDefaults, defineConfig } from "vitest/config";

/**
 * The ROOT test run: every workspace package's unit and integration suites, plus the repo-level
 * checkers under `scripts/`, in one process. `pnpm test` at the root was a bare `vitest run` with
 * no config, which is the same thing — this file exists to keep it that way as the workspace
 * grows a package that must NOT be in it.
 *
 * `packages/dashboard` runs its own vitest with a jsdom environment. Pulling a jsdom suite into
 * this node-environment run would either fail on a missing DOM or, worse, quietly change the
 * environment for every other suite here. It gets its own config and its own CI step; the root run
 * stays exactly what it was.
 *
 * `.next/` is build output — machine-written, large, and containing copies of source files whose
 * test blocks would otherwise be collected and run a second time.
 *
 * The defaults are SPREAD rather than restated. Vitest's own exclude list is the authority on what
 * a test run should never walk into, and a hand-copied version of it goes stale silently.
 */
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "**/.next/**", "packages/dashboard/**"],
  },
});
