/**
 * `buildChildEnv` is the pure logic behind item 7 of the Codex review: the read-only MCP case must
 * not merely omit `RFPHUB_API_KEY`/`RFPHUB_MCP_ENABLE_SUBMIT` from what IT sets — it must actively
 * strip them, so an ambient value inherited from the checker's own process (a developer's shell
 * exporting one for unrelated reasons) can never leak into the "default env, read-only tools only"
 * case and silently make that case untested.
 */
import { describe, expect, it } from "vitest";
import { McpStdioClient, buildChildEnv, findCredentialLeak } from "../mcp-client.mjs";

describe("buildChildEnv", () => {
  it("merges base and env, with env winning on overlap", () => {
    const result = buildChildEnv({ PATH: "/usr/bin", A: "base" }, { A: "override", B: "new" });
    expect(result).toEqual({ PATH: "/usr/bin", A: "override", B: "new" });
  });

  it("deletes an unset key even when only the base provided it", () => {
    const base = { PATH: "/usr/bin", RFPHUB_API_KEY: "rfph_leaked_from_dev_shell" };
    const result = buildChildEnv(base, { RFPHUB_API_BASE: "https://api.example.org" }, [
      "RFPHUB_API_KEY",
      "RFPHUB_MCP_ENABLE_SUBMIT",
    ]);
    expect(result).not.toHaveProperty("RFPHUB_API_KEY");
    expect(result.PATH).toBe("/usr/bin");
    expect(result.RFPHUB_API_BASE).toBe("https://api.example.org");
  });

  it("deletes an unset key even when env explicitly set it — unset always wins", () => {
    const result = buildChildEnv({}, { RFPHUB_API_KEY: "rfph_should_not_survive" }, [
      "RFPHUB_API_KEY",
    ]);
    expect(result).not.toHaveProperty("RFPHUB_API_KEY");
  });

  it("is a no-op beyond the merge when unset is empty", () => {
    const result = buildChildEnv({ A: "1" }, { B: "2" }, []);
    expect(result).toEqual({ A: "1", B: "2" });
  });

  it("does not mutate the base object", () => {
    const base = { A: "1" };
    buildChildEnv(base, { A: "2" }, ["A"]);
    expect(base).toEqual({ A: "1" });
  });
});

describe("findCredentialLeak", () => {
  it("finds a key-shaped string nested in an object", () => {
    const found = findCredentialLeak({ a: { b: ["fine", "rfph_abcd1234"] } });
    expect(found).toEqual({ path: "$.a.b[1]", match: "rfph_abcd1234" });
  });

  it("returns null when nothing matches", () => {
    expect(findCredentialLeak({ a: "fine", b: [1, 2, { c: "also fine" }] })).toBeNull();
  });
});

describe("close()", () => {
  it("reports a spawn failure by name instead of taking the run down", async () => {
    const client = new McpStdioClient("this-binary-does-not-exist", []);
    client.start();
    await expect(client.request("tools/list", {}, { timeoutMs: 2000 })).rejects.toThrow(
      /could not be started/,
    );
    await client.close();
  });
});
