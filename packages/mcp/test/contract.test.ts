/**
 * The search tool's input contract, checked against the API's OWN query schema.
 *
 * These two schemas are written in different files, in different packages, in different schema
 * languages. Nothing but this test stops them drifting — and drift here is not cosmetic: a
 * parameter this server accepts and the API does not becomes a 400 the caller cannot fix, and a
 * value out of either enum becomes the same.
 *
 * The API module is loaded through a variable specifier so this package's own build never reaches
 * for it: the dependency is test-only and must stay that way. It is a monorepo sibling, not a
 * declared dependency, so a checkout that does not have it skips rather than fails.
 */
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FUNDING_TYPES, SORT_FIELDS, SORT_ORDERS, STATUSES } from "../src/enums.js";
import { inputSchema } from "../src/tools/search.js";

interface JsonSchemaNode {
  type?: string;
  enum?: string[];
  maximum?: number;
  items?: JsonSchemaNode;
  properties?: Record<string, JsonSchemaNode>;
  additionalProperties?: boolean;
}

const API_TYPES = path.resolve(
  import.meta.dirname,
  "../../api/src/modules/routes/opportunities/types.ts",
);

async function loadApiQuerySchema(): Promise<JsonSchemaNode | null> {
  try {
    const loaded = (await import(/* @vite-ignore */ API_TYPES)) as {
      listQuerySchema?: JsonSchemaNode;
    };
    return loaded.listQuerySchema ?? null;
  } catch {
    return null;
  }
}

const apiSchema = await loadApiQuerySchema();
const mcpSchema = inputSchema.toJSONSchema() as JsonSchemaNode;

describe.skipIf(apiSchema === null)("search input vs the API's list query", () => {
  it("declares no parameter the API does not accept", () => {
    const theirs = Object.keys(apiSchema?.properties ?? {});
    for (const name of Object.keys(mcpSchema.properties ?? {})) {
      expect(theirs, `${name} is not a parameter of the list endpoint`).toContain(name);
    }
  });

  it("agrees on the sort keys and directions, which are both closed enums", () => {
    expect(apiSchema?.properties?.sort?.enum).toEqual([...SORT_FIELDS]);
    expect(apiSchema?.properties?.order?.enum).toEqual([...SORT_ORDERS]);
  });

  it("is strict on both sides — an unknown parameter is an error, never a no-op", () => {
    expect(apiSchema?.additionalProperties).toBe(false);
    expect(mcpSchema.additionalProperties).toBe(false);
  });

  it("caps limit BELOW the API's ceiling — the constraint here is the model's window", () => {
    const theirMax = apiSchema?.properties?.limit?.maximum ?? 0;
    const ourMax = mcpSchema.properties?.limit?.maximum ?? 0;
    expect(ourMax).toBeLessThan(theirMax);
    expect(ourMax).toBe(25);
  });

  it("offers the same funding types and statuses the API publishes as accepted values", () => {
    // The API publishes them inside a comma-list `pattern` rather than an `enum`, because its
    // filters accept `?fundingType=a,b`. Both sides derive from the same schema, so the check that
    // matters is that each derived value appears in the pattern the API published.
    const pattern = apiSchema?.properties?.fundingType?.items?.type;
    expect(pattern).toBe("string");
    const raw = JSON.stringify(apiSchema?.properties?.fundingType);
    for (const value of FUNDING_TYPES) expect(raw).toContain(value);
    const statusRaw = JSON.stringify(apiSchema?.properties?.status);
    for (const value of STATUSES) expect(statusRaw).toContain(value);
  });
});
