/**
 * The `mcp-publication` criterion's README rule: every configuration snippet pins an exact version,
 * because a moving tag turns "the description digest binds this build" into a promise about a build
 * nobody has seen.
 * `pnpm --filter @the-rfp-hub/mcp build` is not a configuration snippet and must not be flagged.
 */
import { describe, expect, it } from "vitest";
import {
  MCP_REGISTRY_TIMEOUT_FLOOR_MS,
  mcpRegistryTimeout,
  unpinnedReadmeSpecs,
} from "../checks/mcp-publication.mjs";
import { mcpApiBase, schemaErrors } from "../checks/mcp.mjs";

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

describe("the official Registry timeout", () => {
  it("has its own 60 second floor without lowering an explicit larger timeout", () => {
    expect(MCP_REGISTRY_TIMEOUT_FLOOR_MS).toBe(60000);
    expect(mcpRegistryTimeout(15000)).toBe(60000);
    expect(mcpRegistryTimeout(90000)).toBe(90000);
  });
});

describe("mcpApiBase", () => {
  it("hands the server a bare origin, whatever --api spelled", () => {
    expect(mcpApiBase("https://api.example.org/v1/").origin).toBe("https://api.example.org");
    expect(mcpApiBase("https://api.example.org/base?x=1#y").trimmed).toBe(true);
    expect(mcpApiBase("https://api.example.org").trimmed).toBe(false);
  });

  it("names a plaintext non-loopback base the server would refuse at startup", () => {
    expect(mcpApiBase("http://api.example.org").refusedByServer).toBe(true);
    expect(mcpApiBase("http://127.0.0.1:3150").refusedByServer).toBe(false);
    expect(mcpApiBase("http://localhost:3150").refusedByServer).toBe(false);
    expect(mcpApiBase("https://api.example.org").refusedByServer).toBe(false);
  });
});

describe("schemaErrors", () => {
  const schema2020 = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    required: ["total"],
    properties: { total: { type: "number" } },
  };

  it("compiles the 2020-12 dialect the real server's schemas declare", () => {
    // The draft-07 build refuses this outright with "no schema with key or ref …/2020-12/schema",
    // which read as "the tool's output is invalid" when the tool's output was fine.
    expect(schemaErrors(schema2020, { total: 3 })).toBeNull();
  });

  it("still reports a real mismatch under that dialect", () => {
    expect(schemaErrors(schema2020, { total: "many" })).toMatch(/total/);
  });

  it("compiles a schema with no $schema at all", () => {
    expect(schemaErrors({ type: "object" }, {})).toBeNull();
  });
});
