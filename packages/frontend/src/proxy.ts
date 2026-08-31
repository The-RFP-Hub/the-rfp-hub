/**
 * The ONLY server-side code in this package, and it exists for exactly one reason: a
 * Content-Security-Policy with a per-request nonce cannot be a static header.
 *
 * NAMED `proxy`, NOT `middleware`. Next 16 renamed the convention: the file is `proxy.ts` and the
 * exported function must be `proxy` (or a default export) — a file still called `middleware.ts`
 * builds with a deprecation warning, and one that exports the old name under the new filename fails
 * outright. The behaviour this file depends on is unchanged: `config.matcher` is still honoured, and
 * `NextResponse.next({ request: { headers } })` still rewrites the REQUEST headers the render sees,
 * which is the whole mechanism below.
 *
 * It authenticates nothing, reads no cookie and calls no API. Authorization lives in the API and
 * the browser holds the only credential — see `next.config.ts`.
 *
 * The nonce is written onto the REQUEST headers as well as the response, because that is how the
 * framework finds it: it reads the incoming `content-security-policy`, extracts the nonce and
 * stamps it on the script tags it emits. Setting it only on the response would leave those tags
 * unnonced and the page blank. A fresh 128-bit value per request is what makes a nonce worth
 * anything — a fixed one is `'unsafe-inline'` with extra steps.
 */
import { type NextRequest, NextResponse } from "next/server";
import { contentSecurityPolicy } from "./lib/csp";

export function proxy(request: NextRequest): NextResponse {
  const nonce = Buffer.from(crypto.randomUUID().replaceAll("-", ""), "hex").toString("base64");
  const csp = contentSecurityPolicy(
    nonce,
    process.env.NEXT_PUBLIC_API_URL,
    process.env.NEXT_PUBLIC_GA_ID,
  );

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("content-security-policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("content-security-policy", csp);
  return response;
}

export const config = {
  matcher: [
    /*
     * Documents only. Build output under `_next/static` is immutable and cached by the host — a
     * per-request header on it would be both pointless and a cache key nobody wants. A CSP on a
     * JavaScript response governs nothing anyway; it is the HTML that loads it that decides.
     */
    {
      source: "/((?!_next/static|_next/image|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
