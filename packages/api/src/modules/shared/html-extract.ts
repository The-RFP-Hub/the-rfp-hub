/**
 * PURE, dependency-free extraction of the few facts the verifier needs from a fetched page.
 *
 * No parser dependency, on purpose. A DOM implementation is a large amount of code that runs over
 * bytes a stranger controls, on a path whose entire justification is a low-bar anti-spam signal.
 * What is actually needed is a title, some metadata and enough visible text to tell a real page
 * from a soft 404 — and that is reachable with a linear scan, without ever building a tree.
 *
 * The trade is stated rather than hidden: this is NOT a correct HTML parser and must not become
 * the input to anything that renders. Its output is compared against a submission and stored as a
 * text snapshot. Malformed markup degrades it to less information, never to wrong information of
 * the kind that would matter.
 */

/** The handful of named entities that actually appear in titles and meta content, plus numerics. */
const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  "#39": "'",
};

/** Decode character references. Numeric forms are decoded generally; named ones from the table. */
export function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, name: string) => {
    if (name.startsWith("#x") || name.startsWith("#X")) {
      const code = Number.parseInt(name.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (name.startsWith("#")) {
      const code = Number.parseInt(name.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return NAMED[name.toLowerCase()] ?? whole;
  });
}

const squash = (value: string): string => value.replace(/\s+/g, " ").trim();

/*
 * THE SCANNER, and why the markup is no longer found with regular expressions.
 *
 * Every construct below used to be a backtracking regex — `/<!--[\s\S]*?-->/g`, `/<meta\b[^>]*>/gi`,
 * `/<[^>]*>/g` and their siblings. On a page that OPENS a construct and never closes it, such a
 * regex scans to the end of the input from the first opener, fails, and then starts again from the
 * very next character: n openers cost n scans of the rest of the page. That is quadratic, and on
 * bytes a stranger chooses it was measured at ~20 s for 256 KiB of `<!--` and an estimated twenty
 * minutes for the 2 MiB the fetcher keeps — all of it on the API's event loop.
 *
 * The scanner below finds the SAME matches (pinned against the old expressions in
 * `html-extract.test.ts`, on the fixtures and on generated tag soup) with `indexOf`, and keeps the
 * one fact the regex engine could not use: if the closer is missing after this opener, it is
 * missing after every later opener too, because their search ranges are suffixes of this one. So a
 * construct that never closes ends the scan instead of restarting it, and every byte is looked at a
 * bounded number of times.
 *
 * CASE: the regexes were `/i` without `/u`, whose case folding never maps a non-ASCII character
 * onto an ASCII one. Folding ASCII letters only (`asciiLower`) is therefore the same comparison, and
 * keeps every index in the folded copy equal to the index in the original.
 */

/** ASCII-only lowercase: same length as the input, so positions carry over unchanged. */
function asciiLower(value: string): string {
  return value.replace(/[A-Z]+/g, (run) => run.toLowerCase());
}

/** `\w` without the `u` flag. */
function isWordChar(code: number): boolean {
  return (
    (code >= 48 && code <= 57) || // 0-9
    (code >= 65 && code <= 90) || // A-Z
    (code >= 97 && code <= 122) || // a-z
    code === 95 // _
  );
}

/** `\s`, exactly as JavaScript defines it (Unicode spaces and line terminators included). */
const WHITESPACE = /\s/;
function isSpace(value: string, index: number): boolean {
  return index < value.length && WHITESPACE.test(value[index] as string);
}

/** `\b` right after a name that ends in a word character: end of input, or a non-word character. */
function boundaryAt(value: string, index: number): boolean {
  return index >= value.length || !isWordChar(value.charCodeAt(index));
}

/**
 * The first `</name\s*>` at or after `from`, in the folded copy: `[start, end)` of the closer.
 * Each candidate's whitespace run ends before the next candidate begins, so this is linear.
 */
function findCloser(
  lower: string,
  name: string,
  from: number,
): { start: number; end: number } | undefined {
  const needle = `</${name}`;
  let at = lower.indexOf(needle, from);
  while (at !== -1) {
    let cursor = at + needle.length;
    while (isSpace(lower, cursor)) cursor++;
    if (lower.charCodeAt(cursor) === 62 /* > */) return { start: at, end: cursor + 1 };
    at = lower.indexOf(needle, cursor);
  }
  return undefined;
}

interface Element {
  /** Index of the `<` that opened it. */
  start: number;
  /** Index of the `>` that ends the opening tag. */
  openEnd: number;
  /** Index where the closing tag begins — the end of the body. */
  bodyEnd: number;
  /** Index just past the closing tag's `>`. */
  end: number;
}

/**
 * Every `<name\b[^>]*>[\s\S]*?<\/name\s*>` in `html`, left to right and non-overlapping — what
 * `matchAll` with that regex and the `i` flag returns, in linear time.
 *
 * `accept` sees the opening tag's attribute text (between the name and the `>`); returning false
 * skips that opener the way a regex with more conditions in its head would fail there and move on
 * by one character — without skipping its body, exactly as the regex does not.
 */
function* elements(
  html: string,
  lower: string,
  name: string,
  accept?: (attributesStart: number, openEnd: number) => boolean,
): Generator<Element> {
  const opener = `<${name}`;
  let from = 0;
  // The `>` the previous opener found. A rejected opener moves on by one character, and the next
  // opener before that same `>` must not search for it again — that rescan is quadratic too.
  let knownOpenEnd = -1;
  while (from < html.length) {
    const start = lower.indexOf(opener, from);
    if (start === -1) return;
    const afterName = start + opener.length;
    if (!boundaryAt(html, afterName)) {
      from = start + 1;
      continue;
    }
    const openEnd = knownOpenEnd >= afterName ? knownOpenEnd : html.indexOf(">", afterName);
    knownOpenEnd = openEnd;
    // No `>` after this opener means none after any later one either.
    if (openEnd === -1) return;
    if (accept && !accept(afterName, openEnd)) {
      from = start + 1;
      continue;
    }
    const closer = findCloser(lower, name, openEnd + 1);
    // No closer after this tag means none after any later tag: their `>` is at or past this one.
    if (!closer) return;
    yield { start, openEnd, bodyEnd: closer.start, end: closer.end };
    from = closer.end;
  }
}

/** Replace every range with a single space, keeping everything between them. */
function replaceRanges(html: string, ranges: Iterable<{ start: number; end: number }>): string {
  const parts: string[] = [];
  let kept = 0;
  for (const { start, end } of ranges) {
    parts.push(html.slice(kept, start), " ");
    kept = end;
  }
  if (kept === 0) return html;
  parts.push(html.slice(kept));
  return parts.join("");
}

/** `<!--[\s\S]*?-->`, left to right. A comment that never closes ends the scan. */
function* comments(html: string): Generator<{ start: number; end: number }> {
  let from = 0;
  while (true) {
    const start = html.indexOf("<!--", from);
    if (start === -1) return;
    const close = html.indexOf("-->", start + 4);
    if (close === -1) return;
    yield { start, end: close + 3 };
    from = close + 3;
  }
}

/** `<[^>]*>`, left to right. A `<` with no `>` after it ends the scan. */
function* tags(html: string): Generator<{ start: number; end: number }> {
  let from = 0;
  while (true) {
    const start = html.indexOf("<", from);
    if (start === -1) return;
    const close = html.indexOf(">", start + 1);
    if (close === -1) return;
    yield { start, end: close + 1 };
    from = close + 1;
  }
}

/** Everything inside `<script>`/`<style>`/`<noscript>`/comments — never visible, never text. */
function stripNonContent(html: string): string {
  // Sequential, as the regex chain was: each pass sees the previous pass's output.
  let out = replaceRanges(html, comments(html));
  for (const name of ["script", "style", "noscript"]) {
    out = replaceRanges(out, elements(out, asciiLower(out), name));
  }
  return out;
}

/** `<meta\b[^>]*>`, left to right. A `<meta` with no `>` after it ends the scan. */
function* metaTags(html: string, lower: string): Generator<string> {
  let from = 0;
  while (true) {
    const start = lower.indexOf("<meta", from);
    if (start === -1) return;
    if (!boundaryAt(html, start + 5)) {
      from = start + 1;
      continue;
    }
    const close = html.indexOf(">", start + 5);
    if (close === -1) return;
    yield html.slice(start, close + 1);
    from = close + 1;
  }
}

/** `type\s*=\s*["']?application/ld+json`, anywhere in an opening tag's attributes. */
const LD_JSON_TYPE = /type\s*=\s*["']?application\/ld\+json/gi;

/**
 * The opener test for JSON-LD blocks: the attributes between `<script` and the first `>` carry a
 * JSON-LD `type`.
 *
 * Several `<script` openers can share one `>` (`<script <script … type=application/ld+json>`), and
 * each one's attribute text is a suffix of the previous one's. Searching each suffix again would
 * be the quadratic scan this file exists to avoid, so the attributes ending at one `>` are searched
 * ONCE, from the earliest opener, and only the position of the LAST `type` match is kept: an opener
 * qualifies exactly when that match starts at or after its own attributes. (A match cannot run past
 * the `>`, since the pattern contains none, and two matches cannot overlap.)
 */
function ldJsonOpener(html: string): (attributesStart: number, openEnd: number) => boolean {
  let segmentEnd = -1;
  let lastMatch = -1;
  return (attributesStart, openEnd) => {
    if (openEnd !== segmentEnd) {
      segmentEnd = openEnd;
      lastMatch = -1;
      for (const match of html.slice(attributesStart, openEnd).matchAll(LD_JSON_TYPE)) {
        lastMatch = attributesStart + match.index;
      }
    }
    return lastMatch >= attributesStart;
  };
}

export interface ExtractedPage {
  /** `<title>`, decoded and whitespace-collapsed. */
  title?: string;
  /** `og:title`, when present. Often the better title on a marketing page. */
  ogTitle?: string;
  /** `og:description` or `<meta name="description">`. */
  description?: string;
  /** Every `<meta>` with a `name`/`property`, lowercased key → content. */
  meta: Record<string, string>;
  /** Parsed `application/ld+json` blocks. Unparseable blocks are skipped, never thrown on. */
  jsonLd: unknown[];
  /** Visible text: markup removed, whitespace collapsed. Capped by `textLimit`. */
  text: string;
}

export interface ExtractOptions {
  /** Cap on the stored text. Default 200 000 characters — the snapshot column's budget. */
  textLimit?: number;
}

/** Attribute value from a tag's attribute soup, single/double/unquoted. */
function attr(tag: string, name: string): string | undefined {
  const re = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i");
  const m = re.exec(tag);
  if (!m) return undefined;
  return decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
}

/**
 * Everything worth knowing about a fetched page.
 *
 * JSON-LD is read first because a page that publishes structured data is telling us what it is,
 * which beats anything inferred from prose. It is only ever READ — never evaluated, never merged
 * into a record — so a hostile document is at worst noise in a diff a reviewer looks at.
 */
export function extractPage(html: string, options: ExtractOptions = {}): ExtractedPage {
  const limit = options.textLimit ?? 200_000;
  const lower = asciiLower(html);

  // The first `<title>…</title>`.
  const titleElement = elements(html, lower, "title").next().value;
  const title = titleElement
    ? squash(decodeEntities(html.slice(titleElement.openEnd + 1, titleElement.bodyEnd)))
    : undefined;

  const meta: Record<string, string> = {};
  for (const tag of metaTags(html, lower)) {
    const key = attr(tag, "property") ?? attr(tag, "name");
    const content = attr(tag, "content");
    if (!key || content === undefined) continue;
    const normalized = key.trim().toLowerCase();
    // First wins: duplicated meta tags are a template bug, and the first is the one a consumer
    // that stops at the first match would have used.
    if (!(normalized in meta)) meta[normalized] = squash(content);
  }

  const jsonLd: unknown[] = [];
  for (const block of elements(html, lower, "script", ldJsonOpener(html))) {
    try {
      jsonLd.push(JSON.parse(html.slice(block.openEnd + 1, block.bodyEnd).trim()));
    } catch {
      // A malformed block is one signal missing, not a failed verification run.
    }
  }

  const visible = stripNonContent(html);
  const text = squash(decodeEntities(replaceRanges(visible, tags(visible)))).slice(0, limit);

  return {
    title: title || undefined,
    ogTitle: meta["og:title"] || undefined,
    description: meta["og:description"] || meta.description || undefined,
    meta,
    jsonLd,
    text,
  };
}

export interface SoftNotFound {
  /** True when the page answered 2xx but is not really a page for this entry. */
  suspected: boolean;
  /** Which heuristic fired, recorded on the verification run so a reviewer can judge it. */
  heuristic?: string;
}

/** Titles a "gone" page announces itself with. */
const NOT_FOUND_TITLE =
  /not found|404|no longer available|page unavailable|does not exist|expired/i;

/** Below this much visible text, a 200 is a shell rather than a page. */
export const MIN_CONTENT_CHARS = 200;

/**
 * Whether a 2xx response is really a missing page.
 *
 * Sites answer 200 for a deleted programme far more often than they answer 404, so status alone
 * would mark half the dead links as verified. Two cheap signals, and WHICH one fired is recorded:
 * a heuristic whose reasoning is not visible is one a reviewer has to take on faith.
 */
export function detectSoftNotFound(page: ExtractedPage): SoftNotFound {
  const title = page.ogTitle ?? page.title ?? "";
  if (NOT_FOUND_TITLE.test(title)) {
    return {
      suspected: true,
      heuristic: `title matches a not-found phrase: ${JSON.stringify(title)}`,
    };
  }
  if (page.text.length < MIN_CONTENT_CHARS) {
    return {
      suspected: true,
      heuristic: `only ${page.text.length} characters of visible text (< ${MIN_CONTENT_CHARS})`,
    };
  }
  return { suspected: false };
}

export interface BotChallenge {
  suspected: boolean;
  /** The visible signal that made this look like an automated-access challenge. */
  heuristic?: string;
}

const BOT_CHALLENGE_TITLE =
  /just a moment|attention required|checking your browser|security check|verify (?:you are|that you are) (?:a )?human/i;
const BOT_CHALLENGE_TEXT =
  /enable javascript and cookies to continue|cloudflare ray id|checking (?:if|whether) (?:you are human|your browser)|security service to protect itself from online attacks|verify (?:you are|that you are) (?:a )?human/i;

/** Recognise a challenge page without pretending to know how to get around it. */
export function detectBotChallenge(page: ExtractedPage): BotChallenge {
  const title = page.ogTitle ?? page.title ?? "";
  if (BOT_CHALLENGE_TITLE.test(title)) {
    return {
      suspected: true,
      heuristic: `title looks like an automated-access challenge: ${JSON.stringify(title)}`,
    };
  }
  const signal = BOT_CHALLENGE_TEXT.exec(page.text)?.[0];
  if (signal) {
    return {
      suspected: true,
      heuristic: `page text looks like an automated-access challenge: ${JSON.stringify(signal)}`,
    };
  }
  return { suspected: false };
}
