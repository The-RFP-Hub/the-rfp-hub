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
   *
   * `grant-admin` is the first-admin ceremony (docs/auth.md): the operator reaches the database
   * only through the task runner, so every ceremony the operator owns must be a dist entry — a
   * ceremony that exists only under tsx is a ceremony a deployment cannot perform.
   */
  entry: {
    server: "src/server.ts",
    migrate: "scripts/migrate.ts",
    seed: "scripts/seed.ts",
    export: "scripts/export.ts",
    jobs: "scripts/jobs/run-job.ts",
    "grant-admin": "scripts/grant-admin.ts",
    // One-off cleanup after the directory-stub change (scripts/cleanup-rejected-org-stubs.ts):
    // reports by default, deletes only with --apply. A dist entry so a deployment can run it.
    "cleanup-rejected-org-stubs": "scripts/cleanup-rejected-org-stubs.ts",
    // Not a task: the thread a fetched page is read in (`html-extract-bounded.ts`), which looks
    // for it next to the entry that started it — `server.js` or `jobs.js`, both in this directory.
    "html-extract.worker": "src/modules/shared/html-extract.worker.ts",
  },
  format: ["esm"],
  target: "node20",
  platform: "node",
  clean: true,
  sourcemap: true,
  // Runtime deps (fastify, pg, drizzle, …) stay external — only our src is bundled.
});
