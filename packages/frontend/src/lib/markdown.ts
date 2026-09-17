/**
 * A SMALL, CLOSED MARKDOWN SUBSET, parsed to a tree and never to HTML.
 *
 * Publishers write descriptions with bold runs, bullet lists and the odd link, and showing the
 * asterisks raw made every listing look broken. A real markdown library was the obvious answer
 * and the wrong one: it produces HTML, and the whole safety argument of the public page is that
 * nothing a stranger typed ever reaches `innerHTML`. So this parser produces a tree of plain
 * objects, and the renderer turns each node into a React element with text children. Anything the
 * grammar does not know stays as the characters the publisher typed, including raw HTML tags.
 *
 * Grammar: paragraphs split by blank lines; `#`–`###` headings; `-`, `*`, `•` bullets and `1.`
 * numbered items; `**bold**`, `*italic*` / `_italic_`, `` `code` ``, and `[text](https://…)` links
 * on http(s) only. Line breaks inside a paragraph are kept.
 */
export type Inline =
  | { kind: "text"; value: string }
  | { kind: "strong"; children: Inline[] }
  | { kind: "em"; children: Inline[] }
  | { kind: "code"; value: string }
  | { kind: "link"; href: string; children: Inline[] }
  | { kind: "break" };

export type Block =
  | { kind: "paragraph"; children: Inline[] }
  | { kind: "heading"; level: 1 | 2 | 3; children: Inline[] }
  | { kind: "list"; ordered: boolean; items: Inline[][] };

const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/;
const ORDERED = /^\s*\d+[.)]\s+/;
const HEADING = /^(#{1,3})\s+(.*)$/;

export function parseMarkdown(source: string): Block[] {
  const blocks: Block[] = [];
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim() === "") {
      index += 1;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading?.[1] && heading[2] !== undefined) {
      blocks.push({
        kind: "heading",
        level: heading[1].length as 1 | 2 | 3,
        children: parseInline(heading[2].trim()),
      });
      index += 1;
      continue;
    }

    if (BULLET.test(line)) {
      const ordered = ORDERED.test(line);
      const items: Inline[][] = [];
      while (index < lines.length) {
        const candidate = lines[index] ?? "";
        const match = BULLET.exec(candidate);
        if (!match || match[1] === undefined) break;
        items.push(parseInline(match[1].trim()));
        index += 1;
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length) {
      const candidate = lines[index] ?? "";
      if (candidate.trim() === "" || BULLET.test(candidate) || HEADING.test(candidate)) break;
      paragraph.push(candidate.trim());
      index += 1;
    }
    const children: Inline[] = [];
    paragraph.forEach((text, position) => {
      if (position > 0) children.push({ kind: "break" });
      children.push(...parseInline(text));
    });
    blocks.push({ kind: "paragraph", children });
  }

  return blocks;
}

const SAFE_HREF = /^https?:\/\/[^\s<>"']+$/i;

/**
 * Inline runs, left to right, with a plain-text fallback for every opener that never closes: an
 * unmatched `**` is two asterisks the publisher typed, not a formatting error to hide.
 */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let buffer = "";
  let cursor = 0;

  const flush = () => {
    if (buffer) out.push({ kind: "text", value: buffer });
    buffer = "";
  };

  while (cursor < text.length) {
    const rest = text.slice(cursor);

    const code = /^`([^`\n]+)`/.exec(rest);
    if (code?.[1]) {
      flush();
      out.push({ kind: "code", value: code[1] });
      cursor += code[0].length;
      continue;
    }

    const strong = /^\*\*([^*\n](?:[^*\n]|\*(?!\*))*?)\*\*/.exec(rest);
    if (strong?.[1]) {
      flush();
      out.push({ kind: "strong", children: parseInline(strong[1]) });
      cursor += strong[0].length;
      continue;
    }

    const em = /^(?:\*([^*\n]+)\*|_([^_\n]+)_)(?![A-Za-z0-9])/.exec(rest);
    if (em && (em[1] || em[2]) && (cursor === 0 || !/[A-Za-z0-9]/.test(text[cursor - 1] ?? ""))) {
      flush();
      out.push({ kind: "em", children: parseInline(em[1] ?? em[2] ?? "") });
      cursor += em[0].length;
      continue;
    }

    // One level of parentheses inside the address, for the Wikipedia-style URL and the odd
    // `alert(1)` alike; either way the closing bracket is the one after them.
    const link = /^\[([^\]\n]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/.exec(rest);
    if (link?.[1] && link[2]) {
      flush();
      if (SAFE_HREF.test(link[2])) {
        out.push({ kind: "link", href: link[2], children: parseInline(link[1]) });
      } else {
        // An unsafe scheme keeps its text and loses its link; the address is shown, not followed.
        out.push({ kind: "text", value: `${link[1]} (${link[2]})` });
      }
      cursor += link[0].length;
      continue;
    }

    buffer += text[cursor];
    cursor += 1;
  }
  flush();
  return out;
}

/** True when the source carries any syntax the renderer would change, for callers that gate. */
export function looksLikeMarkdown(source: string): boolean {
  return /\*\*|\[[^\]]+\]\(https?:|^\s*(?:[-*•]|\d+[.)])\s+|^#{1,3}\s+|`[^`]+`/m.test(source);
}
