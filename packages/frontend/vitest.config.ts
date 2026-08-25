import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/**
 * The frontend's own test run, deliberately separate from the root one.
 *
 * The root `vitest.config.ts` excludes this package because these suites need a DOM: pulling a
 * jsdom environment into the repository-wide node run would either fail on the missing globals or,
 * worse, quietly change the environment every other suite executes in. This config owns the jsdom
 * half; the root run is unchanged by this package existing.
 *
 * Nothing here reaches the network or a database. The API client is exercised with an injected
 * `fetch`, and the render test with an injected API client, so the whole suite runs offline and in
 * CI without a service.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "jsdom",
    // Date inputs are interpreted in the publisher's local zone. Keep the suite away from UTC so
    // an accidental UTC/local equivalence cannot make timezone-sensitive assertions pass.
    env: { TZ: "America/Sao_Paulo" },
    globals: true,
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    // Build output contains copies of the source, whose test blocks would otherwise be collected
    // and run a second time against compiled code nobody edited.
    exclude: ["**/node_modules/**", "**/.next/**"],
  },
});
