import { defineConfig } from "tsup";

/**
 * Two builds, because the two entry points ship differently.
 *
 * `index` is the library surface: dual ESM/CJS with type declarations, like the other published
 * packages here, because a consumer embedding these tools could be either.
 *
 * `cli` is the `rfphub-mcp` executable: ESM only, and no declarations. Node runs it; nothing
 * `require`s it and nothing imports it for its types, so a CJS copy would be a second artifact to
 * keep in step and a third of the published tarball for a file no loader ever reaches.
 *
 * Only the first build cleans. The second must not, or it would delete what the first just wrote.
 */
export default defineConfig([
  {
    entry: { index: "src/index.ts" },
    format: ["esm", "cjs"],
    outExtension: ({ format }) => ({ js: format === "cjs" ? ".cjs" : ".js" }),
    dts: true,
    clean: true,
    sourcemap: true,
    treeshake: true,
  },
  {
    entry: { cli: "src/cli.ts" },
    format: ["esm"],
    dts: false,
    clean: false,
    sourcemap: true,
    treeshake: true,
  },
]);
