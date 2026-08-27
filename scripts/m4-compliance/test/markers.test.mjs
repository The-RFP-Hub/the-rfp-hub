/**
 * The `sh` block marker convention: the marker is the SECOND WORD OF THE INFO STRING and nothing
 * else — confirmed against `docs/README.md` on the `m4-handoff-docs` branch, the stream that owns
 * `docs/**`. This checker is the consumer of that convention, not the author of it.
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

  it("reads each of the three markers", () => {
    for (const marker of MARKERS) {
      const blocks = parseMarkedBlocks(`\`\`\`sh ${marker}\necho hi\n\`\`\`\n`);
      expect(blocks[0].marker).toBe(marker);
    }
  });

  it("leaves marker null when the info string has no second word", () => {
    const blocks = parseMarkedBlocks("```sh\necho hi\n```\n");
    expect(blocks[0].marker).toBeNull();
  });

  it("leaves marker null for an info-string second word that is not one of the three markers", () => {
    const blocks = parseMarkedBlocks("```sh some-other-word\necho hi\n```\n");
    expect(blocks[0].marker).toBeNull();
  });

  it("does NOT read a marker from a preceding HTML comment — there is no such form", () => {
    const md = "<!-- marker: staging-write -->\n```sh\ncurl -X POST https://example.org\n```\n";
    const blocks = parseMarkedBlocks(md);
    expect(blocks[0].marker).toBeNull();
  });

  it("finds multiple blocks with independent markers", () => {
    const md = [
      "```sh safe-read",
      "curl https://example.org/health",
      "```",
      "",
      "```sh staging-write",
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
