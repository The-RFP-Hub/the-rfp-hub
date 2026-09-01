/**
 * The origin THIS DEPLOYMENT is being reached at, and whether that origin is the ONE canonical
 * production host — the two facts `sitemap.ts` and `robots.ts` need in order to avoid indexing a
 * staging alias or a Vercel preview as if it were a second copy of the real site.
 *
 * THE REQUEST ORIGIN IS DERIVED, NEVER HARD-CODED. `X-Forwarded-Host` and `Host` are how a reverse
 * proxy or the platform's own edge names the address a visitor actually typed, and
 * `X-Forwarded-Proto` is how it says the original request was `https` even though it forwards over
 * plain HTTP internally. A self-hosted copy of this reference frontend can be reached at any
 * hostname its operator chooses, so a literal here would make every fork's sitemap and robots.txt
 * describe production's address rather than their own.
 *
 * THE CANONICAL ORIGIN IS ONE ENVIRONMENT VARIABLE, `NEXT_PUBLIC_SITE_ORIGIN`, set ONLY on the
 * production deployment (see the README's Deployment section and
 * `.github/workflows/frontend-production.yml`). Staging and every Vercel preview leave it unset on
 * purpose: without a canonical origin to compare against, `isCanonicalRequest` can never return
 * true, so those environments stay `noindex` and never publish a sitemap — a preview URL that
 * indexed would compete with the real one for every listing it carries. This is also why the
 * variable is not a literal in this file: `pnpm check:neutral` refuses a plaintext production
 * hostname in source, and an env var is the correct shape for a value that legitimately differs by
 * environment anyway.
 */
import { headers } from "next/headers";

/** A forwarded header may carry a proxy chain; the client-facing hop is the first entry. */
function firstValue(header: string | null | undefined): string | undefined {
  return header?.split(",")[0]?.trim() || undefined;
}

/**
 * `X-Forwarded-Host` WINS OVER `Host`, because a CDN or load balancer in front of this app is free
 * to rewrite `Host` to an internal name — and a deployment where it does would otherwise never
 * match its own canonical origin and would serve `noindex` forever, silently. Both headers are set
 * by the same hop and are equally forgeable by a client that reaches the app directly, so
 * preferring the forwarded one costs nothing that `Host` was not already exposed to.
 */
export function originFromHeaders(
  host: string | null,
  forwardedProto: string | null,
  forwardedHost?: string | null,
): string | null {
  const authority = firstValue(forwardedHost) ?? firstValue(host);
  if (!authority) return null;
  return `${firstValue(forwardedProto) ?? "https"}://${authority}`;
}

/** The one call that actually reads the incoming request. Everything else here is pure. */
export async function requestOrigin(): Promise<string | null> {
  const list = await headers();
  return originFromHeaders(
    list.get("host"),
    list.get("x-forwarded-proto"),
    list.get("x-forwarded-host"),
  );
}

/**
 * The ONE origin this deployment considers itself canonical for, or `undefined` when the operator
 * has not declared one — which is the normal, correct state for staging and every preview.
 *
 * Normalized through `URL().origin` so a trailing slash or a stray path segment in the variable
 * cannot make an otherwise-correct value fail to match a request origin, which never carries either.
 */
export function canonicalSiteOrigin(): string | undefined {
  const raw = process.env.NEXT_PUBLIC_SITE_ORIGIN;
  if (!raw) return undefined;
  try {
    return new URL(raw).origin;
  } catch {
    return undefined;
  }
}

/**
 * Whether THIS REQUEST landed on the declared canonical origin.
 *
 * False whenever `NEXT_PUBLIC_SITE_ORIGIN` is unset, unparsable, or simply different from what the
 * request's own `Host` header says — which is the fail-closed direction: an operator who forgets to
 * set the variable gets a deployment that is quietly not indexed, never one that is indexed by
 * accident on every alias and preview it happens to be reachable at.
 */
export async function isCanonicalRequest(): Promise<boolean> {
  const canonical = canonicalSiteOrigin();
  if (!canonical) return false;
  const origin = await requestOrigin();
  return origin === canonical;
}
