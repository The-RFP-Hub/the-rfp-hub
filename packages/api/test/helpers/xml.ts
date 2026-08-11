/**
 * A deliberately UNFORGIVING XML reader, used by the feed tests to answer two questions at once:
 * is the document well-formed, and does it contain what it must?
 *
 * It is a test helper, not a general parser — it accepts exactly the subset the feed writer emits
 * (declaration, elements, attributes, character data) and REJECTS everything else, which is the
 * point: a real feed reader would too. In particular it throws on an unescaped `<` or a bare `&`
 * in character data, on an unknown entity, on a mismatched or unterminated tag, on a duplicated or
 * unquoted attribute, and on anything after the root element. An escaping bug therefore surfaces
 * as a parse failure rather than as a string assertion that happened not to look for it.
 *
 * Written by hand on purpose: the alternative is taking an XML-parser dependency into the API
 * package to test 200 lines of serializer, and a parser that shares no code with the writer is
 * exactly what makes this an independent check.
 */

export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  /** Decoded character data directly inside this element (excluding descendants'). */
  text: string;
}

const NAME = /^[A-Za-z_][A-Za-z0-9._-]*(:[A-Za-z_][A-Za-z0-9._-]*)?$/;
const REFERENCE = /^&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9A-Fa-f]+);/;

const NAMED: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
};

function resolveReference(ref: string): string {
  const named = NAMED[ref];
  if (named !== undefined) return named;
  const body = ref.slice(2, -1);
  const code = body.startsWith("x") || body.startsWith("X") ? body.slice(1) : body;
  const radix = body.startsWith("x") || body.startsWith("X") ? 16 : 10;
  return String.fromCodePoint(Number.parseInt(code, radix));
}

/** Decode character data, rejecting anything that would have to have been escaped. */
function decode(raw: string, where: string): string {
  let out = "";
  let i = 0;
  while (i < raw.length) {
    const char = raw[i] as string;
    if (char === "<") throw new Error(`unescaped '<' in ${where}`);
    if (char === "&") {
      const match = REFERENCE.exec(raw.slice(i));
      if (!match) {
        throw new Error(`unescaped '&' (or unknown entity) in ${where}: ${raw.slice(i, i + 20)}`);
      }
      out += resolveReference(match[0]);
      i += match[0].length;
      continue;
    }
    out += char;
    i += 1;
  }
  return out;
}

/** Parse a complete XML document, throwing on anything that is not well-formed. */
export function parseXml(source: string): XmlNode {
  let at = 0;

  // Annotated (rather than inferred) so TypeScript treats it as never-returning and narrows the
  // code after every call — which is what lets the checks below read as guards.
  const fail: (message: string) => never = (message) => {
    throw new Error(`${message} (at offset ${at}: ${JSON.stringify(source.slice(at, at + 40))})`);
  };
  const skipSpace = () => {
    while (at < source.length && /\s/.test(source[at] as string)) at += 1;
  };
  const readName = (): string => {
    const start = at;
    while (at < source.length && !/[\s/>=]/.test(source[at] as string)) at += 1;
    const name = source.slice(start, at);
    if (!NAME.test(name)) fail(`invalid element or attribute name ${JSON.stringify(name)}`);
    return name;
  };

  function parseElement(): XmlNode {
    if (source[at] !== "<") fail("expected '<'");
    at += 1;
    const name = readName();
    const attrs: Record<string, string> = {};

    for (;;) {
      skipSpace();
      if (source.startsWith("/>", at)) {
        at += 2;
        return { name, attrs, children: [], text: "" };
      }
      if (source[at] === ">") {
        at += 1;
        break;
      }
      const attrName = readName();
      if (attrName in attrs) fail(`duplicate attribute ${JSON.stringify(attrName)} on <${name}>`);
      skipSpace();
      if (source[at] !== "=") fail(`attribute ${attrName} has no value`);
      at += 1;
      skipSpace();
      const quote = source[at];
      if (quote !== '"' && quote !== "'") fail(`unquoted value for attribute ${attrName}`);
      at += 1;
      const end = source.indexOf(quote, at);
      if (end < 0) fail(`unterminated value for attribute ${attrName}`);
      attrs[attrName] = decode(source.slice(at, end), `@${attrName} of <${name}>`);
      at = end + 1;
    }

    const children: XmlNode[] = [];
    let text = "";
    for (;;) {
      if (at >= source.length) fail(`unterminated element <${name}>`);
      if (source.startsWith("</", at)) {
        at += 2;
        const closing = readName();
        if (closing !== name) fail(`</${closing}> closes <${name}>`);
        skipSpace();
        if (source[at] !== ">") fail(`unterminated closing tag </${closing}`);
        at += 1;
        return { name, attrs, children, text };
      }
      if (source[at] === "<") {
        children.push(parseElement());
        continue;
      }
      const next = source.indexOf("<", at);
      const chunk = source.slice(at, next < 0 ? source.length : next);
      text += decode(chunk, `<${name}>`);
      at = next < 0 ? source.length : next;
    }
  }

  skipSpace();
  if (source.startsWith("<?xml", at)) {
    const end = source.indexOf("?>", at);
    if (end < 0) fail("unterminated XML declaration");
    at = end + 2;
  }
  skipSpace();
  const root = parseElement();
  skipSpace();
  if (at !== source.length) fail("content after the root element");
  return root;
}

/** Direct children with this name. */
export function children(node: XmlNode, name: string): XmlNode[] {
  return node.children.filter((child) => child.name === name);
}

/** The first direct child with this name, if any. */
export function child(node: XmlNode, name: string): XmlNode | undefined {
  return node.children.find((candidate) => candidate.name === name);
}

/** The decoded text of the first direct child with this name. */
export function textOf(node: XmlNode, name: string): string | undefined {
  return child(node, name)?.text;
}
