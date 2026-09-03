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
      { declaration: "margin-top: 2px;", name: "globals.css" },
    ]);
  });

  it("keeps navigation, pagination and repeater targets usable with touch", () => {
    const [globalCss, formCss] = stylesheets.map(([, path]) => readFileSync(path, "utf8"));
    expect(globalCss).toMatch(
      /\.button-primary\s*\{[^}]*min-block-size:\s*var\(--control-touch\);/s,
    );
    expect(globalCss).toMatch(/\.segmented\s*\{[^}]*flex-wrap:\s*wrap;/s);
    expect(globalCss).toMatch(
      /\.segmented button\s*\{[^}]*flex:\s*0 0 auto;[^}]*min-block-size:\s*var\(--control-touch\);/s,
    );
    expect(globalCss).toMatch(
      /\.section-nav a\s*\{[^}]*min-block-size:\s*var\(--control-touch\);[^}]*min-inline-size:\s*var\(--control-touch\);/s,
    );
    expect(globalCss).toMatch(/\.pagination\s*\{[^}]*flex-wrap:\s*wrap;/s);
    expect(globalCss).toMatch(
      /\.pagination button,\s*\.pagination a\s*\{[^}]*min-block-size:\s*var\(--control-touch\);[^}]*min-inline-size:\s*var\(--control-touch\);/s,
    );
    expect(globalCss).toMatch(
      /@media \(pointer: coarse\)\s*\{[\s\S]*?button,[\s\S]*?summary\s*\{[^}]*min-block-size:\s*var\(--control-touch\);/s,
    );
    expect(globalCss).toMatch(
      /\.duplicate-actions button\s*\{[^}]*min-block-size:\s*var\(--control-touch\);[^}]*white-space:\s*nowrap;/s,
    );
    // The header's own links: inline text until a coarse pointer makes them a thumb target.
    expect(globalCss).toMatch(
      /@media \(pointer: coarse\)\s*\{[\s\S]*?\.shell-nav a\s*\{[^}]*min-block-size:\s*var\(--control-touch\);/s,
    );
    expect(formCss).toMatch(/\.itemHead\s*\{[^}]*flex-wrap:\s*wrap;/s);
    expect(formCss).toMatch(
      /\.small\s*\{[^}]*min-block-size:\s*var\(--control-touch\);[^}]*min-inline-size:\s*var\(--control-touch\);[^}]*padding:\s*var\(--space-2\);/s,
    );
  });

  it("keeps the skip link keyboard-visible and reserves faint ink for decoration", () => {
    const css = readFileSync(stylesheets[0][1], "utf8");
    expect(css).toMatch(/\.skip-link\s*\{[^}]*transform:\s*translateY\(-150%\);/s);
    expect(css).toMatch(/\.skip-link:focus\s*\{[^}]*transform:\s*translateY\(var\(--space-2\)\);/s);
    expect(css).not.toMatch(/(?:^|\n)\.faint\b/);
    expect(css).toMatch(
      /\.publisher-journey li:not\(:last-child\)::after\s*\{[^}]*color:\s*var\(--ink-faint\);/s,
    );
  });

  it("aligns form controls from their label edge without reserving guidance height", () => {
    const css = readFileSync(stylesheets[1][1], "utf8");
    expect(css).toMatch(/\.cols\s*\{[^}]*align-items:\s*flex-start;/s);
    expect(css).toMatch(/\.guidanceRow\s*\{[^}]*flex-wrap:\s*wrap;/s);
    expect(css).not.toMatch(/\.control\s*\{[^}]*margin-top:\s*auto;/s);
  });

  it("gives both table scroll containers a local edge fade and contained scrolling", () => {
    for (const [, path] of stylesheets) {
      const css = readFileSync(path, "utf8");
      expect(css).toContain("background-attachment: local, local, scroll, scroll;");
      expect(css).toContain("overscroll-behavior-inline: contain;");
      expect(css).toContain("scrollbar-gutter: stable;");
    }
  });

  it("uses full-border callouts and keeps publish consequences distinct without hue", () => {
    const [globalCss, formCss] = stylesheets.map(([, path]) =>
      readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, ""),
    );
    expect(`${globalCss}\n${formCss}`).not.toMatch(/border-(?:left|right):\s*[2-9]/);
    expect(globalCss).toMatch(/\.callout\s*\{[^}]*border:\s*2px solid var\(--line\);/s);
    expect(formCss).toMatch(/\.consequence\s*\{[^}]*border-style:\s*dotted;/s);
    expect(formCss).toMatch(/\.consequenceNow\s*\{[^}]*border-style:\s*solid;/s);
    expect(formCss).toMatch(/\.consequenceLater\s*\{[^}]*border-style:\s*dashed;/s);
  });

  it("marks active filters with ink, weight and an explicit hueless label", () => {
    const css = readFileSync(stylesheets[0][1], "utf8");
    const controls = css.match(/\.filters \.is-set select,[\s\S]*?\}/)?.[0] ?? "";
    const marker = css.match(/\.filters \.is-set label::after\s*\{[^}]*\}/s)?.[0] ?? "";
    expect(controls).toContain("border-color: var(--ink)");
    expect(controls).toContain("font-weight: 600");
    expect(marker).toContain('content: " — active"');
    expect(`${controls}${marker}`).not.toContain("--accent");
  });

  it("keeps the sign-in heading reset while removing the remaining inline visual exceptions", () => {
    const css = readFileSync(stylesheets[0][1], "utf8");
    expect(css).toMatch(/\.signin h2\s*\{[^}]*margin-top:\s*0;/s);
    for (const path of [
      join(process.cwd(), "src", "app", "keys", "page.tsx"),
      join(process.cwd(), "src", "app", "review", "page.tsx"),
      join(process.cwd(), "src", "app", "organizations", "[slug]", "page.tsx"),
    ]) {
      expect(readFileSync(path, "utf8")).not.toContain("style={{");
    }
  });
});
