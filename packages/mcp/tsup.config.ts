import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "tsup";

/**
 * Two builds: `index` is the dual ESM/CJS library surface, `cli` is the executable, ESM only.
 *
 * NEITHER BUILD CLEANS. tsup starts array entries together, so a cleaning entry can delete what
 * the other already wrote — and the file it eats is `dist/cli.js`, the one `bin` points at.
 * The directory is removed HERE instead, once, before either build exists to be raced with.
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
