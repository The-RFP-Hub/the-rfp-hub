/**
 * THE REGEX EXTRACTOR AS IT WAS, kept only as the oracle the linear scanner is compared against.
 *
 * `extractPage` in `src/modules/shared/html-extract.ts` used to find markup with backtracking
 * regular expressions, which are quadratic on a page that opens a construct and never closes it.
 * It was rewritten as a linear scanner that must find EXACTLY the same things; `html-extract.test.ts`
 * holds the two side by side on the fixtures and on generated tag soup. Never import this from
 * `src/` — it is the slow version, on purpose. Only call it with small inputs.
 */
import { type ExtractedPage, decodeEntities } from "../../src/modules/shared/html-extract.js";

const squash = (value: string): string => value.replace(/\s+/g, " ").trim();

function stripNonContent(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript\s*>/gi, " ");
}

function attr(tag: string, name: string): string | undefined {
  const re = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i");
  const m = re.exec(tag);
  if (!m) return undefined;
  return decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
}

export function extractPageWithRegexes(
  html: string,
  options: { textLimit?: number } = {},
): ExtractedPage {
  const limit = options.textLimit ?? 200_000;

  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
  const title = titleMatch ? squash(decodeEntities(titleMatch[1] ?? "")) : undefined;

  const meta: Record<string, string> = {};
  for (const [tag] of html.matchAll(/<meta\b[^>]*>/gi)) {
    const key = attr(tag, "property") ?? attr(tag, "name");
    const content = attr(tag, "content");
    if (!key || content === undefined) continue;
    const normalized = key.trim().toLowerCase();
    if (!(normalized in meta)) meta[normalized] = squash(content);
  }

  const jsonLd: unknown[] = [];
  for (const [, body] of html.matchAll(
    /<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script\s*>/gi,
  )) {
    try {
      jsonLd.push(JSON.parse((body ?? "").trim()));
    } catch {
      // skipped, as in the original
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
