import { defineConfig } from "tsup";

export default defineConfig({
  /**
   * The server, plus the three admin tasks that have to run in a deployed environment.
   *
   * `migrate`, `seed` and `export` were previously reachable only through `tsx` against the
   * TypeScript sources, which the runtime image does not carry — so a deployment could serve the
   * API but could not create its own schema or load its own data. Building them as their own
   * entry points makes each a plain `node packages/api/dist/<task>.js` invocation, which is what a
   * one-off task runner (an ECS RunTask, a `docker run`, a `kubectl run`) can actually launch.
   */
  entry: {
    server: "src/server.ts",
    migrate: "scripts/migrate.ts",
    seed: "scripts/seed.ts",
    export: "scripts/export.ts",
  },
  format: ["esm"],
  target: "node20",
  platform: "node",
  clean: true,
  sourcemap: true,
  // Runtime deps (fastify, pg, drizzle, …) stay external — only our src is bundled.
});
