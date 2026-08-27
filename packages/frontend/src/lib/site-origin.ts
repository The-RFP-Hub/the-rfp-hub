/**
 * The origin THIS DEPLOYMENT is being reached at — what `sitemap.ts` and `robots.ts` need to state
 * an absolute URL, and the one thing neither file may hard-code.
 *
 * DERIVED FROM THE REQUEST, not from an environment variable. This package deliberately has one,
 * `NEXT_PUBLIC_API_URL` (see the README), and it names the API this browser talks to, not the
 * address this frontend itself is served from. A self-hosted copy of this reference frontend — the
 * README documents that path explicitly — can be reached at any hostname its operator chooses, so a
 * literal here would make every fork's sitemap and robots.txt describe production's address rather
 * than their own.
 *
 * The `Host` header is what a reverse proxy or the platform's own edge sets to the address a visitor
 * actually typed; `X-Forwarded-Proto` is how that layer tells the app the original request was
 * `https` even though it forwards over plain HTTP internally, which is the normal shape behind
 * Vercel and most other hosts. Both are read here, not assumed.
 */
import { headers } from "next/headers";

export function originFromHeaders(
  host: string | null,
  forwardedProto: string | null,
): string | null {
  if (!host) return null;
  const proto = forwardedProto?.split(",")[0]?.trim() || "https";
  return `${proto}://${host}`;
}

/** The one call that actually reads the incoming request. Everything else here is pure. */
export async function requestOrigin(): Promise<string | null> {
  const list = await headers();
  return originFromHeaders(list.get("host"), list.get("x-forwarded-proto"));
}
