import { defineConfig } from "tsup";

/**
 * `index` is the library surface and is dual ESM/CJS, like the other published packages here.
 * `cli` is the `rfphub-mcp` bin; `bin` points at the ESM build, which is the one that runs. Type
 * declarations are generated for `index` alone — nothing imports the executable for its types.
 */
export default defineConfig({
  entry: { index: "src/index.ts", cli: "src/cli.ts" },
  format: ["esm", "cjs"],
  outExtension: ({ format }) => ({ js: format === "cjs" ? ".cjs" : ".js" }),
  dts: { entry: { index: "src/index.ts" } },
  clean: true,
  sourcemap: true,
  treeshake: true,
});
