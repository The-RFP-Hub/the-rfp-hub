import { createApiClient } from "@/lib/api";
import { readConfig } from "@/lib/config";
/**
 * `GET /logos/[slug]` — a verified publisher's logo, proxied through this origin.
 *
 * The whole reason this route exists is in `src/lib/csp.ts`: `img-src` is `'self'` and `data:`
 * only, because loading a publisher-named `logoUrl` straight into a reader's browser would leak
 * that reader's IP to whatever host the publisher named. This route makes the request itself —
 * server to server — and relays only the bytes and a narrow set of headers, never the upstream URL
 * or its failure detail.
 *
 * ONLY verified publishers reach this route: `GET /v1/publishers` is the verified set (a listed-only
 * organization never has a `logoUrl` from the API in the first place). An unknown slug, a publisher
 * with no logo, or ANY fetch failure all answer identically — 404 — so a reader (or a hostile probe)
 * cannot distinguish "no such publisher" from "the upstream is unreachable" from "the file was too
 * big". `isSafeLogoUrl` (src/lib/logo-proxy.ts) is the SSRF gate; `redirect: "manual"` means a
 * redirecting upstream is treated as a failure rather than followed somewhere this check never saw.
 */
import {
  LOGO_FETCH_TIMEOUT_MS,
  MAX_LOGO_BYTES,
  acceptableLogoContentType,
  isSafeLogoUrl,
} from "@/lib/logo-proxy";
import type { NextRequest } from "next/server";

const NOT_FOUND = new Response(null, { status: 404 });

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;

  const config = readConfig({ apiUrl: process.env.NEXT_PUBLIC_API_URL });
  if (!config.ok) return NOT_FOUND;

  let logoUrl: string | null;
  try {
    const api = createApiClient({ baseUrl: config.config.apiBaseUrl });
    const { items } = await api.publishers.list();
    const publisher = items.find((item) => item.slug === slug);
    logoUrl = publisher?.logoUrl ?? null;
  } catch {
    return NOT_FOUND;
  }
  if (!logoUrl || !isSafeLogoUrl(logoUrl)) return NOT_FOUND;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LOGO_FETCH_TIMEOUT_MS);
  let upstream: Response;
  try {
    upstream = await fetch(logoUrl, {
      redirect: "manual",
      signal: controller.signal,
      headers: { accept: "image/png,image/jpeg,image/webp,image/svg+xml" },
    });
  } catch {
    return NOT_FOUND;
  } finally {
    clearTimeout(timeout);
  }

  if (!upstream.ok) return NOT_FOUND;

  const contentType = acceptableLogoContentType(upstream.headers.get("content-type"));
  if (!contentType) return NOT_FOUND;

  const declaredLength = Number(upstream.headers.get("content-length") ?? "");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_LOGO_BYTES) return NOT_FOUND;

  const body = upstream.body;
  if (!body) return NOT_FOUND;

  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = await readCapped(body, MAX_LOGO_BYTES);
  } catch {
    return NOT_FOUND;
  }

  const headers = new Headers({
    "content-type": contentType,
    "cache-control": "public, max-age=86400, s-maxage=604800",
    "x-content-type-options": "nosniff",
  });
  // A hostile SVG is a script-execution vector like any other document; this header keeps it inert
  // even though the browser is asked to render it as an image.
  if (contentType === "image/svg+xml") {
    headers.set("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'");
  }

  return new Response(new Blob([bytes], { type: contentType }), { status: 200, headers });
}

/** Reads `stream` fully, throwing rather than returning a truncated body once `limit` is exceeded. */
async function readCapped(
  stream: ReadableStream<Uint8Array>,
  limit: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) throw new Error("logo exceeds the size cap");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(new ArrayBuffer(total));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
