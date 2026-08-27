import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
 * NEITHER BUILD CLEANS. Asking one of two entries in an array config to clean is a race: tsup
 * starts them together, so the cleaner can delete what the other has already written, and the file
 * it eats is `dist/cli.js` — the one `bin` points at, which nothing else in the build would notice
 * was missing. The directory is therefore removed HERE, once, while this config module is being
 * evaluated and before either build exists to be raced with.
 */
const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), "dist");
fs.rmSync(dist, { recursive: true, force: true });

export default defineConfig([
  {
    entry: { index: "src/index.ts" },
    format: ["esm", "cjs"],
    outExtension: ({ format }) => ({ js: format === "cjs" ? ".cjs" : ".js" }),
    dts: true,
    clean: false,
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
