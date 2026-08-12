/**
 * A tiny XML serializer that escapes BY CONSTRUCTION — the only way this module lets a caller
 * produce markup is by describing a tree of elements, and every name, attribute value and text
 * node it writes goes through the escaper on the way out. There is no "raw" escape hatch, so no
 * feed field can ever be concatenated into a document unescaped: a title containing
 * `A & B <script>` is character data, not markup, and stays that way.
 *
 * The feeds are the first thing this API serves that is not JSON, so the escaping rules are
 * written out rather than assumed:
 *
 * - TEXT escapes `&`, `<` and `>`. `>` is not strictly required (XML 1.0 §2.4 only mandates it to
 *   break up a literal `]]>`), but escaping it unconditionally means a `]]>` inside user text can
 *   never terminate anything, and costs nothing;
 * - ATTRIBUTE values escape those three plus `"` and `'` — both quote forms, so the value is safe
 *   whichever delimiter the writer picks (this one always writes `"`) — and additionally TAB, LF
 *   and CR, which an XML processor would otherwise normalize to a space (XML 1.0 §3.3.3), quietly
 *   changing the value a consumer reads back;
 * - characters that are NOT LEGAL IN XML 1.0 AT ALL are dropped, not escaped. C0 controls other
 *   than TAB/LF/CR have no numeric-character-reference form in XML 1.0 either, so `&#1;` would be
 *   just as fatal as the raw byte; the same goes for the non-characters U+FFFE/U+FFFF and for
 *   unpaired surrogates, which cannot be encoded as UTF-8 at all. Dropping them keeps a hostile —
 *   or simply dirty — upstream string from producing a document no parser will accept.
 *
 * The output is deliberately deterministic: attribute order is the caller's, indentation is two
 * spaces per level, and nothing carries a timestamp of its own. The feed routes hash the exact
 * bytes into a strong `ETag`, so identical data must serialize identically.
 */

/**
 * The XML 1.0 §2.2 `Char` production, verbatim: TAB/LF/CR, then every code point from U+0020 up,
 * minus the surrogate block (U+D800–U+DFFF) and the non-characters U+FFFE/U+FFFF.
 */
function isXmlChar(codePoint: number): boolean {
  if (codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d) return true;
  if (codePoint >= 0x20 && codePoint <= 0xd7ff) return true;
  if (codePoint >= 0xe000 && codePoint <= 0xfffd) return true;
  return codePoint >= 0x10000 && codePoint <= 0x10ffff;
}

/**
 * Drop everything XML 1.0 cannot represent (see the module comment: dropped, never escaped).
 *
 * Iterating with `for…of` walks CODE POINTS, so a well-formed surrogate pair is seen as the single
 * astral character it encodes and survives, while an UNPAIRED surrogate is seen as itself, lands
 * in the excluded U+D800–U+DFFF range, and is removed.
 */
export function stripIllegalXmlChars(value: string): string {
  let out = "";
  for (const char of value) {
    if (isXmlChar(char.codePointAt(0) ?? 0)) out += char;
  }
  return out;
}

/** Escape character data: `&`, `<`, `>`. */
export function escapeXmlText(value: string): string {
  return stripIllegalXmlChars(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Escape an attribute value: character data, plus both quote forms and the normalized whitespace. */
export function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value)
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    .replace(/\t/g, "&#9;")
    .replace(/\n/g, "&#10;")
    .replace(/\r/g, "&#13;");
}

/** XML Name production, restricted to the ASCII subset every element this API writes uses. */
const XML_NAME = /^[A-Za-z_][A-Za-z0-9._-]*(:[A-Za-z_][A-Za-z0-9._-]*)?$/;

function assertName(name: string): string {
  if (!XML_NAME.test(name)) throw new Error(`invalid XML name: ${JSON.stringify(name)}`);
  return name;
}

/**
 * One element. `text` and `children` are mutually exclusive — no feed document here needs mixed
 * content, and forbidding it keeps the writer trivial (and the failure loud if that ever changes).
 *
 * `children` and `attrs` tolerate absent entries so an optional element or attribute can be
 * written inline (`entry.postedAt && text("published", …)`) instead of through an accumulator.
 */
export interface XmlElement {
  name: string;
  attrs?: Record<string, string | undefined>;
  text?: string;
  children?: (XmlElement | undefined | false | null)[];
}

/** Element with children (or none) — the constructor for every non-leaf node. */
export function el(
  name: string,
  attrs?: Record<string, string | undefined>,
  children?: (XmlElement | undefined | false | null)[],
): XmlElement {
  return { name, attrs, children };
}

/** Leaf element carrying character data. */
export function text(
  name: string,
  value: string,
  attrs?: Record<string, string | undefined>,
): XmlElement {
  return { name, attrs, text: value };
}

function renderAttrs(attrs: XmlElement["attrs"]): string {
  if (!attrs) return "";
  return Object.entries(attrs)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([name, value]) => ` ${assertName(name)}="${escapeXmlAttribute(value)}"`)
    .join("");
}

function renderElement(node: XmlElement, depth: number): string {
  const pad = "  ".repeat(depth);
  const open = `${pad}<${assertName(node.name)}${renderAttrs(node.attrs)}`;

  const children = (node.children ?? []).filter((child): child is XmlElement => Boolean(child));
  if (node.text !== undefined && children.length > 0) {
    throw new Error(`<${node.name}> has both text and children (mixed content is not supported)`);
  }
  if (node.text !== undefined) return `${open}>${escapeXmlText(node.text)}</${node.name}>`;
  if (children.length === 0) return `${open}/>`;

  const body = children.map((child) => renderElement(child, depth + 1)).join("\n");
  return `${open}>\n${body}\n${pad}</${node.name}>`;
}

/** Serialize a document: XML declaration, the root element, UTF-8, trailing newline. */
export function renderXmlDocument(root: XmlElement): string {
  return `<?xml version="1.0" encoding="utf-8"?>\n${renderElement(root, 0)}\n`;
}
