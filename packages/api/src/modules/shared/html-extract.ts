/**
 * PURE, dependency-free extraction of the few facts the verifier needs from a fetched page.
 *
 * No parser dependency, on purpose. A DOM implementation is a large amount of code that runs over
 * bytes a stranger controls, on a path whose entire justification is a low-bar anti-spam signal.
 * What is actually needed is a title, some metadata and enough visible text to tell a real page
 * from a soft 404 — and that is regex-reachable without ever building a tree.
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

/** Everything inside `<script>`/`<style>`/`<noscript>`/comments — never visible, never text. */
function stripNonContent(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript\s*>/gi, " ");
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

  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
  const title = titleMatch ? squash(decodeEntities(titleMatch[1] ?? "")) : undefined;

  const meta: Record<string, string> = {};
  for (const [tag] of html.matchAll(/<meta\b[^>]*>/gi)) {
    const key = attr(tag, "property") ?? attr(tag, "name");
    const content = attr(tag, "content");
    if (!key || content === undefined) continue;
    const normalized = key.trim().toLowerCase();
    // First wins: duplicated meta tags are a template bug, and the first is the one a consumer
    // that stops at the first match would have used.
    if (!(normalized in meta)) meta[normalized] = squash(content);
  }

  const jsonLd: unknown[] = [];
  for (const [, body] of html.matchAll(
    /<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script\s*>/gi,
  )) {
    try {
      jsonLd.push(JSON.parse((body ?? "").trim()));
    } catch {
      // A malformed block is one signal missing, not a failed verification run.
    }
  }

  const text = squash(decodeEntities(stripNonContent(html).replace(/<[^>]*>/g, " "))).slice(
    0,
    limit,
  );

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
