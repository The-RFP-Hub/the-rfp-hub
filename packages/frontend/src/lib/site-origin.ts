/**
 * The origin this deployment is reached at, and whether it is the ONE canonical production host.
 * Derived, never hard-coded: a self-hosted copy answers at whatever hostname its operator chose.
 */
import { headers } from "next/headers";

/** A forwarded header may carry a proxy chain; the client-facing hop is the first entry. */
function firstValue(header: string | null | undefined): string | undefined {
  return header?.split(",")[0]?.trim() || undefined;
}

/**
 * `X-Forwarded-Host` wins over `Host`: a CDN or load balancer may rewrite `Host` to an internal
 * name, and such a deployment would otherwise never match its canonical origin — silently, forever.
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

/** The one call that reads the request. Everything else here is pure. */
export async function requestOrigin(): Promise<string | null> {
  const list = await headers();
  return originFromHeaders(
    list.get("host"),
    list.get("x-forwarded-proto"),
    list.get("x-forwarded-host"),
  );
}

/** `undefined` when none was declared — the normal state off production. */
export function canonicalSiteOrigin(): string | undefined {
  const raw = process.env.NEXT_PUBLIC_SITE_ORIGIN;
  if (!raw) return undefined;
  try {
    return new URL(raw).origin;
  } catch {
    return undefined;
  }
}

/** Fail-closed: an unset, unparsable or different value costs indexing, never a preview's privacy. */
export async function isCanonicalRequest(): Promise<boolean> {
  const canonical = canonicalSiteOrigin();
  if (!canonical) return false;
  const origin = await requestOrigin();
  return origin === canonical;
}
