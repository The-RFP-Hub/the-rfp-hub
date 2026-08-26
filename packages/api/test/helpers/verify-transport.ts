/**
 * A fixture transport for the verification suites.
 *
 * The fetcher's transport seam exists so extraction, the field diff and the redirect walk can be
 * tested deterministically, against pages that do not move, without a socket. What the fixture
 * transport deliberately does NOT replace is the address validation: that lives in the real
 * transport because it is a fact about a RESOLVED address, and the SSRF cases therefore drive the
 * real one.
 */
import type {
  HopResponse,
  SourceTransport,
} from "../../src/modules/services/verification/fetcher.service.js";

export interface FixturePage {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  /** The byte cap stopped the stream: the body is a PREFIX of what the server was serving. */
  truncated?: boolean;
}

/**
 * A transport backed by a URL → page map.
 *
 * An unmapped URL is a 404 rather than a throw: "the page is not there" is a real outcome the
 * verifier has to record, and a thrown fixture error would test the wrong branch.
 */
export function fixtureTransport(pages: Record<string, FixturePage>): SourceTransport {
  return async (url: string): Promise<HopResponse> => {
    const page = pages[url];
    if (!page) {
      return {
        status: 404,
        headers: { "content-type": "text/html" },
        bytes: Buffer.from("<html><head><title>Not found</title></head><body></body></html>"),
        truncated: false,
      };
    }
    return {
      status: page.status ?? 200,
      headers: { "content-type": "text/html; charset=utf-8", ...(page.headers ?? {}) },
      bytes: Buffer.from(page.body ?? ""),
      truncated: page.truncated ?? false,
    };
  };
}

/** A plausible programme page: a title, OpenGraph metadata, and enough prose to clear the soft-404 bar. */
export function sourcePage(options: {
  title: string;
  ogTitle?: string;
  body?: string;
  deadline?: string;
  amount?: string;
  organization?: string;
}): string {
  const filler =
    "Applications are reviewed on a rolling basis by a committee of ecosystem contributors. " +
    "Successful teams receive funding in tranches against agreed milestones, and are expected to " +
    "publish their work under a permissive open source licence. Read the full guidelines below " +
    "before applying, and reach out on the forum with any questions about scope or eligibility.";
  return [
    "<!doctype html><html><head>",
    `<title>${options.title}</title>`,
    options.ogTitle ? `<meta property="og:title" content="${options.ogTitle}">` : "",
    '<meta name="description" content="Programme details and how to apply.">',
    "</head><body>",
    `<h1>${options.title}</h1>`,
    `<p>${options.body ?? filler}</p>`,
    options.deadline ? `<p>Deadline: ${options.deadline}</p>` : "",
    options.amount ? `<p>Awards up to ${options.amount}.</p>` : "",
    options.organization ? `<p>Run by ${options.organization}.</p>` : "",
    "</body></html>",
  ].join("\n");
}
