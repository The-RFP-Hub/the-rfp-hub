import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const stylesheets = [
  ["globals.css", join(process.cwd(), "src", "app", "globals.css")],
  [
    "OpportunityForm.module.css",
    join(process.cwd(), "src", "components", "OpportunityForm.module.css"),
  ],
] as const;

function declarations(pattern: RegExp) {
  return stylesheets.flatMap(([name, path]) =>
    readFileSync(path, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((line, index) => ({ declaration: line.trim(), line: index + 1, name }))
      .filter(({ declaration }) => pattern.test(declaration)),
  );
}

describe("the visual-system token boundary", () => {
  it("pins the semantic display tokens to the sizes they replaced", () => {
    const css = readFileSync(stylesheets[0][1], "utf8");
    for (const [token, value] of [
      ["--text-h1", "1.95rem"],
      ["--text-h3", "1.05rem"],
      ["--text-h3-compact", "1rem"],
      ["--text-lede", "1.05rem"],
      ["--text-metric", "1.6rem"],
    ]) {
      expect(css).toContain(`${token}: ${value};`);
    }
    expect(css).not.toContain("--text-h1-compact");
  });

  it("keeps raw font-relative sizing only on inline code", () => {
    const raw = declarations(/^font-size:/)
      .filter(({ declaration }) => !declaration.includes("var(--text-"))
      .map(({ declaration, name }) => ({ declaration, name }));
    expect(raw).toEqual([{ declaration: "font-size: 0.88em;", name: "globals.css" }]);
  });

  it("keeps raw spacing only where it is optical, corrective, or font-relative", () => {
    const spacing = declarations(
      /^(?:gap|margin(?:-(?:top|right|bottom|left))?|padding(?:-(?:top|right|bottom|left))?):/,
    );
    const raw = spacing.filter(({ declaration }) => {
      const values = declaration.slice(declaration.indexOf(":") + 1);
      return /(?:^|\s)-?(?:\d*\.\d+|\d+)(?:px|r?em)\b/.test(values);
    });

    expect(raw.map(({ declaration, name }) => ({ declaration, name }))).toEqual([
      { declaration: "padding: 0.1em 0.4em;", name: "globals.css" },
      { declaration: "padding: 2px;", name: "globals.css" },
      { declaration: "margin: 0 -2px;", name: "globals.css" },
      { declaration: "padding-bottom: 2px;", name: "globals.css" },
      { declaration: "margin-left: 0.1rem;", name: "globals.css" },
      { declaration: "margin: -1px;", name: "globals.css" },
      { declaration: "padding: 2px var(--space-2);", name: "globals.css" },
      { declaration: "margin-left: -0.35rem;", name: "globals.css" },
      { declaration: "margin-top: 2px;", name: "globals.css" },
      { declaration: "margin-top: 2px;", name: "globals.css" },
      {
        declaration: "padding: 0.1rem 0.45rem;",
        name: "OpportunityForm.module.css",
      },
    ]);
  });

  it("leaves the intrinsic form alignment rules semantic", () => {
    const css = readFileSync(stylesheets[1][1], "utf8");
    expect(css).toMatch(/\.cols\s*\{[^}]*align-items:\s*stretch;/s);
    expect(css).toMatch(/\.control\s*\{[^}]*margin-top:\s*auto;/s);
  });
});
