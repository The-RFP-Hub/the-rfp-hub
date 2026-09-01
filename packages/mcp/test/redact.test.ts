/**
 * Redaction is the backstop, and a backstop is only worth having if it holds on EVERY surface. The
 * property test below injects a synthetic key into each field of each shape a tool result can take
 * and asserts it never survives.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  REDACTED,
  clearRegisteredSecrets,
  findSecretPaths,
  redact,
  redactString,
  registerSecret,
  stringHasSecret,
} from "../src/redact.js";
import { FAKE_KEY } from "./helpers.js";

afterEach(() => {
  clearRegisteredSecrets();
});

describe("shape matching", () => {
  it("catches a key-shaped substring anywhere in a string", () => {
    expect(redactString(`before ${FAKE_KEY} after`)).toBe(`before ${REDACTED} after`);
    expect(redactString(`{"authorization":"Bearer ${FAKE_KEY}"}`)).not.toContain(FAKE_KEY);
  });

  it("leaves ordinary text alone", () => {
    expect(redactString("rfph_ is a prefix but this is not a key")).toContain("rfph_ is a prefix");
    expect(redactString("no credentials here")).toBe("no credentials here");
  });

  it("is stateless across calls — a global regex would alternate", () => {
    const text = `x ${FAKE_KEY} y`;
    expect(stringHasSecret(text)).toBe(true);
    expect(stringHasSecret(text)).toBe(true);
    expect(stringHasSecret(text)).toBe(true);
  });

  it("scrubs a registered literal even when it does not match the shape", () => {
    registerSecret("totally-different-credential-format");
    expect(redactString("value: totally-different-credential-format")).toContain(REDACTED);
  });

  it("refuses to register a string short enough to redact everything", () => {
    registerSecret("a");
    expect(redactString("a normal sentence")).toBe("a normal sentence");
  });
});

describe("recursive redaction", () => {
  it("covers nested objects, arrays and object keys", () => {
    const input = {
      list: [{ deep: { deeper: `see ${FAKE_KEY}` } }],
      [FAKE_KEY]: "the key is the property name",
    };
    const out = JSON.stringify(redact(input));
    expect(out).not.toContain(FAKE_KEY);
    expect(out).toContain(REDACTED);
  });

  it("does not mutate its input", () => {
    const input = { a: FAKE_KEY };
    redact(input);
    expect(input.a).toBe(FAKE_KEY);
  });

  it("redacts an Error's message and stack rather than throwing on it", () => {
    const err = new Error(`failed with ${FAKE_KEY}`);
    const out = redact(err) as Error;
    expect(out.message).not.toContain(FAKE_KEY);
    expect(out.stack ?? "").not.toContain(FAKE_KEY);
  });

  it("survives a cycle instead of blowing the stack", () => {
    const cyclic: Record<string, unknown> = { key: FAKE_KEY };
    cyclic.self = cyclic;
    const out = redact(cyclic) as Record<string, unknown>;
    expect(out.key).toBe(REDACTED);
    expect(out.self).toBe("[CIRCULAR]");
  });
});

describe("property: a key injected into any field of any surface never survives", () => {
  // The three shapes a tool result takes: the text block, the structured block, and an error.
  const surfaces: Record<string, () => unknown> = {
    "content text": () => ({ content: [{ type: "text", text: `x ${FAKE_KEY}` }] }),
    "structured scalar": () => ({ structuredContent: { field: FAKE_KEY } }),
    "structured nested array": () => ({ structuredContent: { items: [{ t: [FAKE_KEY] }] } }),
    "structured key name": () => ({ structuredContent: { [FAKE_KEY]: 1 } }),
    "error message": () => new Error(`boom ${FAKE_KEY}`),
    "error details": () => ({ code: "exec_failed", details: { body: { hint: FAKE_KEY } } }),
    "audit line": () => ({ tool: "submit_opportunity", inputSummary: { keys: [FAKE_KEY] } }),
  };

  for (const [name, build] of Object.entries(surfaces)) {
    it(`scrubs the ${name}`, () => {
      const serialized = JSON.stringify(redact(build()), (_k, v) =>
        v instanceof Error ? { message: v.message } : v,
      );
      expect(serialized).not.toContain(FAKE_KEY);
    });
  }
});

describe("findSecretPaths", () => {
  it("reports every location, with a path", () => {
    const doc = {
      title: "fine",
      description: `hidden ${FAKE_KEY}`,
      contacts: [{ note: FAKE_KEY }],
    };
    const hits = findSecretPaths(doc);
    expect(hits).toContain("/description");
    expect(hits).toContain("/contacts[0]/note");
    expect(hits).not.toContain("/title");
  });

  it("reports a key used as a property name", () => {
    expect(findSecretPaths({ [FAKE_KEY]: 1 })[0]).toContain("property name");
  });

  it("is empty for a clean document", () => {
    expect(findSecretPaths({ a: 1, b: ["x", { c: null }] })).toEqual([]);
  });
});
