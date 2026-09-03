/**
 * A well-formedness reader for XML, for the one question the compliance checker can honestly ask of
 * an XML response: would a feed reader be able to parse this at all?
 *
 * An XML document has no JSON Schema, so the schema half of criterion 2 does not apply to it (see
 * the note in packages/api/src/modules/routes/feeds/index.ts — Atom and RSS are defined by RFC 4287
 * and the RSS 2.0 specification, not by this API's own components). What CAN be verified is that
 * the bytes are a parseable document: matched tags, one root, quoted and non-repeated attributes,
 * escaped character data, nothing trailing. An escaping bug — the failure that actually happens in
 * a serializer — surfaces here as a parse error rather than as a green check.
 *
 * Written by hand, like packages/api/test/helpers/xml.ts and for the same two reasons: the checker
 * takes no dependency it does not need, and a reader that shares no code with the writer is what
 * makes this an independent check. The difference from that helper is deliberate: this one accepts
 * everything well-formed XML may contain (comments, CDATA sections, processing instructions, a
 * doctype), because it is pointed at whatever a live deployment serves and must not report a
 * perfectly parseable document as broken. It asks about well-formedness ONLY — no validity, no
 * namespace resolution, no schema.
 */

/**
 * Name characters, kept to the ASCII range the syndication formats use. Deliberately permissive
 * about the colon: this reader does not resolve namespaces, so `dc:creator` is just a name.
 */
const NAME = /^[A-Za-z_][A-Za-z0-9._-]*(:[A-Za-z_][A-Za-z0-9._-]*)?$/;
const REFERENCE = /^&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9A-Fa-f]+);/;

/**
 * Parse a document for well-formedness.
 *
 * Returns `{ ok: true, root, elements }` — the root element's name and how many elements the
 * document carries, both of which are worth printing in a sign-off report — or `{ ok: false, error }`
 * with the first thing that made the document unparseable. Never throws.
 */
export function checkWellFormed(source) {
  try {
    return { ok: true, ...parse(String(source)) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function parse(input) {
  // A leading byte-order mark is legal and is not part of the document.
  const source = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  let at = 0;
  let elements = 0;

  const fail = (message) => {
    throw new Error(`${message} (at offset ${at}: ${JSON.stringify(source.slice(at, at + 40))})`);
  };
  const skipSpace = () => {
    while (at < source.length && /\s/.test(source[at])) at += 1;
  };
  const readName = () => {
    const start = at;
    while (at < source.length && !/[\s/>=]/.test(source[at])) at += 1;
    const name = source.slice(start, at);
    if (!NAME.test(name)) fail(`invalid element or attribute name ${JSON.stringify(name)}`);
    return name;
  };
  /** Consume up to and including `close`, or fail saying what was never closed. */
  const skipUntil = (close, what) => {
    const end = source.indexOf(close, at);
    if (end < 0) fail(`unterminated ${what}`);
    at = end + close.length;
  };

  /**
   * Everything that may appear around and between elements: whitespace, comments, processing
   * instructions (the XML declaration among them) and a doctype. Returns false when the next thing
   * is not one of those, so the caller can decide whether an element is expected there.
   */
  const skipMisc = () => {
    for (;;) {
      skipSpace();
      if (source.startsWith("<!--", at)) skipUntil("-->", "comment");
      else if (source.startsWith("<?", at)) skipUntil("?>", "processing instruction");
      else if (source.startsWith("<!DOCTYPE", at)) skipDoctype();
      else return;
    }
  };

  /** A doctype, internal subset included — the only place a bare `>` may appear before the root. */
  const skipDoctype = () => {
    at += "<!DOCTYPE".length;
    for (;;) {
      if (at >= source.length) fail("unterminated doctype");
      if (source[at] === "[") skipUntil("]", "doctype internal subset");
      else if (source[at] === ">") {
        at += 1;
        return;
      } else at += 1;
    }
  };

  /** Character data: rejects an unescaped `<` (unreachable by construction) and a bad reference. */
  const readText = (where) => {
    while (at < source.length && source[at] !== "<") {
      if (source[at] === "&") {
        const match = REFERENCE.exec(source.slice(at));
        if (!match) {
          fail(`unescaped '&' (or an entity this reader does not know) in ${where}`);
        }
        at += match[0].length;
        continue;
      }
      at += 1;
    }
  };

  function parseElement() {
    if (source[at] !== "<") fail("expected '<'");
    at += 1;
    const name = readName();
    elements += 1;
    const seen = new Set();

    for (;;) {
      skipSpace();
      if (source.startsWith("/>", at)) {
        at += 2;
        return name;
      }
      if (source[at] === ">") {
        at += 1;
        break;
      }
      if (at >= source.length) fail(`unterminated start tag <${name}>`);
      const attr = readName();
      if (seen.has(attr)) fail(`duplicate attribute ${JSON.stringify(attr)} on <${name}>`);
      seen.add(attr);
      skipSpace();
      if (source[at] !== "=") fail(`attribute ${attr} of <${name}> has no value`);
      at += 1;
      skipSpace();
      const quote = source[at];
      if (quote !== '"' && quote !== "'") fail(`unquoted value for attribute ${attr} of <${name}>`);
      at += 1;
      const end = source.indexOf(quote, at);
      if (end < 0) fail(`unterminated value for attribute ${attr} of <${name}>`);
      // The attribute value is character data too: an unescaped `<` or a bare `&` is not well-formed
      // there either, and that is exactly what a URL with query parameters gets wrong.
      const value = source.slice(at, end);
      const before = at;
      readTextIn(value, `@${attr} of <${name}>`, before);
      at = end + 1;
    }

    // Content.
    for (;;) {
      if (at >= source.length) fail(`unterminated element <${name}>`);
      if (source.startsWith("</", at)) {
        at += 2;
        const closing = readName();
        if (closing !== name) fail(`</${closing}> closes <${name}>`);
        skipSpace();
        if (source[at] !== ">") fail(`unterminated closing tag </${closing}`);
        at += 1;
        return name;
      }
      if (source.startsWith("<!--", at)) {
        skipUntil("-->", "comment");
        continue;
      }
      if (source.startsWith("<![CDATA[", at)) {
        at += "<![CDATA[".length;
        skipUntil("]]>", "CDATA section");
        continue;
      }
      if (source.startsWith("<?", at)) {
        skipUntil("?>", "processing instruction");
        continue;
      }
      if (source[at] === "<") {
        parseElement();
        continue;
      }
      readText(`<${name}>`);
    }
  }

  /** Character-data rules applied to a slice that has already been extracted (attribute values). */
  function readTextIn(value, where, offset) {
    for (let i = 0; i < value.length; i++) {
      if (value[i] === "<") {
        at = offset + i;
        fail(`unescaped '<' in ${where}`);
      }
      if (value[i] === "&") {
        const match = REFERENCE.exec(value.slice(i));
        if (!match) {
          at = offset + i;
          fail(`unescaped '&' (or an entity this reader does not know) in ${where}`);
        }
        i += match[0].length - 1;
      }
    }
  }

  skipMisc();
  if (at >= source.length) fail("the document contains no element");
  const root = parseElement();
  skipMisc();
  if (at !== source.length) fail("content after the root element");
  return { root, elements };
}
