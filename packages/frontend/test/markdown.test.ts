import { looksLikeMarkdown, parseInline, parseMarkdown } from "@/lib/markdown";
import { describe, expect, it } from "vitest";

describe("the markdown subset", () => {
  it("splits paragraphs, keeps line breaks, and reads headings and lists", () => {
    const blocks = parseMarkdown(
      "# Round 40\n\nFirst line\nsecond line\n\n- one\n- two\n\n1. a\n2) b",
    );
    expect(blocks.map((b) => b.kind)).toEqual(["heading", "paragraph", "list", "list"]);
    expect(blocks[1]).toEqual({
      kind: "paragraph",
      children: [
        { kind: "text", value: "First line" },
        { kind: "break" },
        { kind: "text", value: "second line" },
      ],
    });
    expect(blocks[2]).toMatchObject({
      ordered: false,
      items: [[{ value: "one" }], [{ value: "two" }]],
    });
    expect(blocks[3]).toMatchObject({ ordered: true });
  });

  it("reads bold, italics, code and http links", () => {
    expect(
      parseInline("**bold** and *em* and _em_ and `x` and [site](https://a.example/p)"),
    ).toEqual([
      { kind: "strong", children: [{ kind: "text", value: "bold" }] },
      { kind: "text", value: " and " },
      { kind: "em", children: [{ kind: "text", value: "em" }] },
      { kind: "text", value: " and " },
      { kind: "em", children: [{ kind: "text", value: "em" }] },
      { kind: "text", value: " and " },
      { kind: "code", value: "x" },
      { kind: "text", value: " and " },
      { kind: "link", href: "https://a.example/p", children: [{ kind: "text", value: "site" }] },
    ]);
  });

  it("leaves unmatched markers, raw HTML and unsafe links as text", () => {
    expect(parseInline("2 ** 3 and <img src=x onerror=alert(1)>")).toEqual([
      { kind: "text", value: "2 ** 3 and <img src=x onerror=alert(1)>" },
    ]);
    expect(parseInline("[run](javascript:alert(1))")).toEqual([
      { kind: "text", value: "run (javascript:alert(1))" },
    ]);
    expect(parseInline("snake_case_name stays")).toEqual([
      { kind: "text", value: "snake_case_name stays" },
    ]);
  });

  it("says whether rendering would change anything", () => {
    expect(looksLikeMarkdown("Plain text, nothing else.")).toBe(false);
    expect(looksLikeMarkdown("A **bold** claim")).toBe(true);
    expect(looksLikeMarkdown("- a list")).toBe(true);
  });
});
