/**
 * M4-4b's README rule: every configuration snippet a reader copies must pin an exact, immutable
 * version. A moving tag is what turns "the description digest binds this build" into a promise
 * about a build nobody has seen. `pnpm --filter @the-rfp-hub/mcp build` names a workspace package
 * rather than something to install, so it is not a configuration snippet and must not be flagged.
 */
import { describe, expect, it } from "vitest";
import { unpinnedReadmeSpecs } from "../checks/mcp.mjs";

const fenced = (...lines) => ["```json", ...lines, "```"].join("\n");

describe("unpinnedReadmeSpecs", () => {
  it("accepts an exact version, in a shell line and in a JSON args array", () => {
    const readme = [
      fenced('      "args": ["-y", "@the-rfp-hub/mcp@0.1.0"]'),
      "```sh",
      "claude mcp add --transport stdio rfp-hub -- npx -y @the-rfp-hub/mcp@0.1.0",
      "```",
    ].join("\n\n");
    expect(unpinnedReadmeSpecs(readme)).toEqual([]);
  });

  it("flags @latest", () => {
    const readme = fenced('      "args": ["-y", "@the-rfp-hub/mcp@latest"]');
    expect(unpinnedReadmeSpecs(readme)).toHaveLength(1);
    expect(unpinnedReadmeSpecs(readme)[0]).toContain("@latest");
  });

  it("flags a dist-tag and a range as well as no version at all", () => {
    for (const spec of ["@next", "@^0.1.0", ""]) {
      const readme = `\`\`\`sh\nnpx -y @the-rfp-hub/mcp${spec}\n\`\`\``;
      expect(unpinnedReadmeSpecs(readme)).toHaveLength(1);
    }
  });

  it("does not flag a workspace command or prose", () => {
    const readme = [
      "```sh",
      "pnpm --filter @the-rfp-hub/mcp build",
      "pnpm --filter @the-rfp-hub/mcp test",
      "```",
      "",
      "The `@the-rfp-hub/mcp` package speaks MCP over stdio.",
    ].join("\n");
    expect(unpinnedReadmeSpecs(readme)).toEqual([]);
  });
});
