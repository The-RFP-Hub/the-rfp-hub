/**
 * The `sh` block marker convention: this checker is the first consumer of it, so getting the
 * parser right against both forms (info-string and preceding-comment) matters as much as the
 * convention itself — see the module docstring in markers.mjs for the two forms.
 */
import { describe, expect, it } from "vitest";
import { MARKERS, parseMarkedBlocks, shellBlocks } from "../markers.mjs";

describe("parseMarkedBlocks", () => {
  it("reads a marker from the fence's own info string", () => {
    const blocks = parseMarkedBlocks("```sh safe-read\ncurl https://example.org\n```\n");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ lang: "sh", marker: "safe-read", line: 1 });
    expect(blocks[0].source).toBe("curl https://example.org");
  });

  it("reads a marker from an HTML comment immediately preceding the fence", () => {
    const md = "<!-- marker: staging-write -->\n```sh\ncurl -X POST https://example.org\n```\n";
    const blocks = parseMarkedBlocks(md);
    expect(blocks[0]).toMatchObject({ marker: "staging-write", line: 2 });
  });

  it("reads a preceding-comment marker across one blank line", () => {
    const md = "<!-- marker: no-run -->\n\n```sh\naws ecs update-service\n```\n";
    const blocks = parseMarkedBlocks(md);
    expect(blocks[0].marker).toBe("no-run");
  });

  it("leaves marker null when neither form is present", () => {
    const blocks = parseMarkedBlocks("```sh\necho hi\n```\n");
    expect(blocks[0].marker).toBeNull();
  });

  it("ignores an info-string token that is not one of the three markers", () => {
    const blocks = parseMarkedBlocks("```sh some-other-word\necho hi\n```\n");
    expect(blocks[0].marker).toBeNull();
  });

  it("finds multiple blocks with independent markers", () => {
    const md = [
      "```sh safe-read",
      "curl https://example.org/health",
      "```",
      "",
      "<!-- marker: staging-write -->",
      "```sh",
      "curl -X POST https://example.org/v1/keys",
      "```",
    ].join("\n");
    const blocks = parseMarkedBlocks(md);
    expect(blocks).toHaveLength(2);
    expect(blocks.map((b) => b.marker)).toEqual(["safe-read", "staging-write"]);
  });

  it("preserves every declared marker id", () => {
    expect(MARKERS).toEqual(["safe-read", "no-run", "staging-write"]);
  });
});

describe("shellBlocks", () => {
  it("includes sh/shell/bash/console but excludes other languages", () => {
    const md = ["```sh", "a", "```", "```js", "b", "```", "```bash", "c", "```"].join("\n");
    const blocks = shellBlocks(md);
    expect(blocks.map((b) => b.lang)).toEqual(["sh", "bash"]);
  });
});
