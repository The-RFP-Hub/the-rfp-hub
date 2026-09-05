/**
 * `server.json` checked against the code it describes. THE DIGEST CATCHES DRIFT, NOT A RUG PULL: a
 * publisher who changes description, code and digest together defeats it completely. What holds
 * against a changed `latest` is that every README example pins an immutable npm version, which is
 * asserted here too.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { digestOf } from "../src/canonical.js";
import { SERVER_VERSION } from "../src/server.js";
import * as fetchTool from "../src/tools/fetch.js";
import * as searchTool from "../src/tools/search.js";
import * as submitTool from "../src/tools/submit.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "server.json"), "utf8")) as {
  name: string;
  version: string;
  packages: {
    identifier: string;
    version: string;
    transport: { type: string };
    environmentVariables: { name: string; isSecret: boolean }[];
    packageArguments?: { type: string; name: string; isRequired?: boolean }[];
  }[];
  _meta: Record<string, { digest: string }>;
};
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
  name: string;
  version: string;
  mcpName: string;
};
const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");

/** Every description this build registers, keyed by tool name. */
const TOOL_DESCRIPTIONS: Record<string, string> = {
  [searchTool.TOOL_NAME]: searchTool.TOOL_DESCRIPTION,
  [fetchTool.TOOL_NAME]: fetchTool.TOOL_DESCRIPTION,
  [submitTool.TOOL_NAME]: submitTool.TOOL_DESCRIPTION,
};

const META_KEY = "io.github.the-rfp-hub/tool-descriptions";

describe("server.json agrees with the package", () => {
  it("carries the same registry name as package.json's mcpName, in the organization's own case", () => {
    expect(manifest.name).toBe(pkg.mcpName);
    // The Registry grants `io.github.<login>/*` in the login's exact case and matches it as a
    // case-sensitive prefix. The organization's login is `The-RFP-Hub`.
    expect(manifest.name).toBe("io.github.The-RFP-Hub/rfp-hub");
  });

  it("names the npm package this workspace publishes, at one consistent version", () => {
    const npmPackage = manifest.packages[0];
    expect(npmPackage?.identifier).toBe(pkg.name);
    expect(npmPackage?.version).toBe(manifest.version);
    expect(manifest.version).toBe(SERVER_VERSION);
    // `package.json` carries `0.0.0` until the first `changeset version` run computes the release
    // number from the pending changeset. Before that bump the manifest states the version this
    // build WILL publish as; from the bump onward the two must agree exactly, and this asserts it.
    if (pkg.version !== "0.0.0") expect(pkg.version).toBe(manifest.version);
  });

  /** `server.json` ships INSIDE the tarball, so a manifest left behind is published as part of the
   * release it disagrees with — 0.1.2 did exactly that. Both fields, checked unconditionally. */
  it("carries package.json's version in both of its version fields", () => {
    expect(manifest.version).toBe(pkg.version);
    expect(manifest.packages[0]?.version).toBe(pkg.version);
  });

  it("declares stdio, which is the only transport this build serves", () => {
    expect(manifest.packages[0]?.transport.type).toBe("stdio");
  });

  it("marks the credential as a secret and nothing else", () => {
    const vars = manifest.packages[0]?.environmentVariables ?? [];
    const secret = vars.filter((v) => v.isSecret).map((v) => v.name);
    expect(secret).toEqual(["RFPHUB_API_KEY"]);
  });

  it("documents every variable the server actually reads, and no others", () => {
    const declared = (manifest.packages[0]?.environmentVariables ?? []).map((v) => v.name).sort();
    expect(declared).toEqual(["RFPHUB_API_BASE", "RFPHUB_API_KEY"]);
  });

  it("declares --state-dir as an argument rather than a variable", () => {
    const args = manifest.packages[0]?.packageArguments ?? [];
    expect(args.map((a) => a.name)).toEqual(["--state-dir"]);
    expect(args[0]?.type).toBe("named");
    expect(args[0]?.isRequired).toBe(false);
  });
});

describe("tool descriptions have not drifted from the manifest", () => {
  it("hashes to the digest the manifest carries", () => {
    expect(manifest._meta[META_KEY]?.digest).toBe(digestOf(TOOL_DESCRIPTIONS));
  });
});

describe("the README's own mitigation", () => {
  it("leads with one client-neutral connection contract before naming client adapters", () => {
    const neutral = readme.indexOf("### Client-neutral connection");
    const adapters = readme.indexOf("### Equivalent client examples");

    expect(neutral).toBeGreaterThan(-1);
    expect(adapters).toBeGreaterThan(neutral);

    const contract = readme.slice(neutral, adapters);
    expect(contract).toContain("| Transport | `stdio` |");
    expect(contract).toContain("| Command | `npx` |");
    expect(contract).toContain("RFPHUB_API_BASE");
    expect(contract).toContain("RFPHUB_API_KEY");
    for (const provider of ["Codex", "Claude", "Cursor", "VS Code"]) {
      expect(contract).not.toContain(provider);
    }
  });

  it("pins an exact version in every configuration example — never a moving tag", () => {
    expect(readme).not.toContain("@the-rfp-hub/mcp@latest");
    // Every version-bearing mention carries an explicit `x.y.z`. A bare mention of the package
    // NAME is prose (the heading, the `--filter` in the development section) and is left alone.
    for (const match of readme.matchAll(/@the-rfp-hub\/mcp(@[^\s"'`)]+)?/g)) {
      const version = match[1];
      if (version === undefined) continue; // A prose mention of the package name, not a command.
      expect(version).toMatch(/^@\d+\.\d+\.\d+$/);
      if (pkg.version !== "0.0.0") expect(version).toBe(`@${pkg.version}`);
    }
  });

  it("states the interlock's limit rather than overclaiming it", () => {
    expect(readme).toContain("Nothing here should be read as");
    expect(readme).toContain("same operating-system user");
  });
});
