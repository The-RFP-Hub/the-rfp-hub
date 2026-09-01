/**
 * Two lints over the text a client shows a model. ARCHITECTURE LEAK: naming a table or a class
 * teaches the model about a system it cannot reach and turns a refactor into a behavior change.
 * TOOL POISONING: a description is prose injected into the model's context, so it is a place an
 * instruction addressed to the agent could hide.
 */
import { describe, expect, it } from "vitest";
import * as fetchTool from "../src/tools/fetch.js";
import * as searchTool from "../src/tools/search.js";
import * as submitTool from "../src/tools/submit.js";

const DESCRIPTIONS: Record<string, string> = {
  [searchTool.TOOL_NAME]: searchTool.TOOL_DESCRIPTION,
  [fetchTool.TOOL_NAME]: fetchTool.TOOL_DESCRIPTION,
  [submitTool.TOOL_NAME]: submitTool.TOOL_DESCRIPTION,
};

/** Every parameter description a client is shown, pulled out of the JSON Schema the SDK emits. */
function parameterDescriptions(schema: unknown, out: string[] = []): string[] {
  if (schema === null || typeof schema !== "object") return out;
  const record = schema as Record<string, unknown>;
  if (typeof record.description === "string") out.push(record.description);
  for (const value of Object.values(record)) parameterDescriptions(value, out);
  return out;
}

const ALL_TEXT: [string, string][] = [
  ...Object.entries(DESCRIPTIONS),
  ...[searchTool.inputSchema, fetchTool.inputSchema, submitTool.inputSchema].flatMap((schema, i) =>
    parameterDescriptions(schema.toJSONSchema()).map(
      (text, j) => [`input schema ${i} field ${j}`, text] as [string, string],
    ),
  ),
];

const IMPLEMENTATION_TERMS = [
  /\bprisma\b/i,
  /\bdrizzle\b/i,
  /\brepository\b/i,
  /\bwhere:/i,
  /\bselect \*/i,
  /\bpostgres(ql)?\b/i,
  /\bfastify\b/i,
  /\bmigration\b/i,
  /\bopportunities\s+table\b/i,
  /\bapi_keys?\b/i,
  /\baudit_log\b/i,
  /\bsource_system\b/i,
  /\.service\.ts\b/i,
  /\.repository\.ts\b/i,
];

/**
 * Imperatives aimed at the AGENT, not at the person choosing a tool.
 *
 * Phrased narrowly on purpose: "Use the id returned by …" is legitimate guidance about the
 * parameter, while "you must always call this first" is an instruction about the agent's behavior.
 * The patterns below target the second shape.
 */
const AGENT_IMPERATIVES = [
  /\bignore (all |any )?(previous|prior|above)\b/i,
  /\byou (must|should) (always|never)\b/i,
  /\bdo not tell\b/i,
  /\bwithout (telling|asking|informing) the user\b/i,
  /\bbefore (using|calling) any other tool\b/i,
  /\bsystem prompt\b/i,
  /\balways call this\b/i,
];

describe("architecture leak", () => {
  for (const [where, text] of ALL_TEXT) {
    it(`${where} names no implementation detail`, () => {
      for (const pattern of IMPLEMENTATION_TERMS) {
        expect(text, `${where} matched ${pattern}`).not.toMatch(pattern);
      }
    });
  }
});

describe("tool poisoning", () => {
  for (const [where, text] of ALL_TEXT) {
    it(`${where} carries no imperative addressed to the agent`, () => {
      for (const pattern of AGENT_IMPERATIVES) {
        expect(text, `${where} matched ${pattern}`).not.toMatch(pattern);
      }
    });
  }
});

describe("the descriptions say what each tool answers", () => {
  it("search says the full descriptions are not in its results", () => {
    expect(DESCRIPTIONS[searchTool.TOOL_NAME]).toContain("Full descriptions are not included");
  });

  it("submit says it is two-step and that the first call writes nothing", () => {
    const text = DESCRIPTIONS[submitTool.TOOL_NAME] ?? "";
    expect(text).toContain("two-step");
    expect(text).toContain("writes nothing");
    expect(text).toContain("their own terminal");
  });

  it("fetch says the document is third-party text", () => {
    expect(DESCRIPTIONS[fetchTool.TOOL_NAME]).toContain("third-party");
  });
});
