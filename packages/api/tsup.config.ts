import { defineConfig } from "tsup";

export default defineConfig({
  /**
   * The server, plus the four admin tasks that have to run in a deployed environment.
   *
   * `migrate`, `seed` and `export` were previously reachable only through `tsx` against the
   * TypeScript sources, which the runtime image does not carry — so a deployment could serve the
   * API but could not create its own schema or load its own data. Building them as their own
   * entry points makes each a plain `node packages/api/dist/<task>.js` invocation, which is what a
   * one-off task runner (an ECS RunTask, a `docker run`, a `kubectl run`) can actually launch.
   *
   * `jobs` is the same idea for the nightly maintenance work: `node dist/jobs.js <name>` is what
   * the scheduled workflow starts as a container task, which is why there is no public job
   * endpoint and no shared job token. See packages/api/docs/jobs.md.
   */
  entry: {
    server: "src/server.ts",
    migrate: "scripts/migrate.ts",
    seed: "scripts/seed.ts",
    export: "scripts/export.ts",
    jobs: "scripts/jobs/run-job.ts",
  },
  format: ["esm"],
  target: "node20",
  platform: "node",
  clean: true,
  sourcemap: true,
  // Runtime deps (fastify, pg, drizzle, …) stay external — only our src is bundled.
});
