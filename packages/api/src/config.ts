/** Runtime configuration, read from the environment with local-friendly defaults. */
export interface AppConfig {
  databaseUrl: string;
  port: number;
  host: string;
  /**
   * Base URL of the upstream funding-map registry API the seed loader ingests from.
   * Deployment-specific — set via SOURCE_API_URL (see .env-example). Empty unless configured.
   */
  sourceApiUrl: string;
  /** Provenance namespace recorded on seeded entries (source_system column + public id prefix). */
  sourceSystem: string;
  /**
   * Base URL the OpenAPI document advertises as its `servers[0].url` (see plugins/swagger.ts).
   * Defaults to `/` — relative, and therefore correct wherever the server happens to be reachable,
   * which is what local development runs with.
   *
   * In a deployed environment this is the API's OWN origin, never the apex: the apex is the
   * specification's origin, and the Standard's canonical documents and their identifiers are owned
   * by `packages/standard` — no route in this package answers those paths. Pointing
   * `servers[0].url` at the apex would advertise the wrong host for every API operation.
   */
  publicBaseUrl: string;
  /**
   * Max size of the pg pool. Bound this for shared database instances where connection budget is
   * split across multiple services. Defaults to 10 — pg's own default — so a fresh deployment
   * with no shared-instance constraints needs no configuration.
   */
  dbPoolMax: number;
}

const isProduction = process.env.NODE_ENV === "production";

// Fail fast in production: a missing DATABASE_URL must never silently fall back to a localhost
// database that doesn't exist there. Dev/test keep the docker-compose default so `pnpm dev` works
// with zero setup.
if (isProduction && !process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required when NODE_ENV=production (no localhost fallback).");
  process.exit(1);
}

const DEFAULT_PORT = 3001;

/**
 * A set-but-unusable PORT falls back to the default instead of binding somewhere nobody is talking
 * to. `Number("")` is 0, NOT NaN, so an empty or whitespace-only value — the normal shape of a
 * templated-but-unsupplied env var in a compose file or an orchestrator's config map — would
 * otherwise bind an OS-assigned ephemeral port while every probe still points at 3001. Anything
 * that is not a whole port number in 1..65535 is treated the same way.
 */
export function readPort(raw: string | undefined, fallback = DEFAULT_PORT): number {
  const parsed = Number((raw ?? "").trim());
  const usable = Number.isInteger(parsed) && parsed > 0 && parsed <= 65535;
  return usable ? parsed : fallback;
}

const DEFAULT_DB_POOL_MAX = 10;

/**
 * A set-but-unusable DB_POOL_MAX falls back to the default (pg's own default of 10) rather than
 * disabling the bound entirely — same defensive shape as `readPort`: `Number("")` is 0, NOT NaN,
 * so an empty or whitespace-only value must be treated the same as an invalid one.
 */
export function readDbPoolMax(raw: string | undefined, fallback = DEFAULT_DB_POOL_MAX): number {
  const parsed = Number((raw ?? "").trim());
  const usable = Number.isInteger(parsed) && parsed > 0;
  return usable ? parsed : fallback;
}

/**
 * Hosts whose traffic never leaves the machine — the only ones allowed to advertise a plaintext
 * base URL, because there is no network segment on which that plaintext could be observed or
 * tampered with. The set is deliberately narrow, and deliberately says nothing about any
 * particular domain:
 *
 * - `localhost` and any `*.localhost` name: RFC 6761 §6.3 reserves the whole subtree to resolve to
 *   loopback, so `http://api.localhost:3001` is a legitimate development origin;
 * - the entire IPv4 loopback block `127.0.0.0/8` (RFC 1122 §3.2.1.3), not merely `127.0.0.1` —
 *   every address in it is loopback, and per-service aliases like `127.0.0.2` are a common habit;
 * - `::1`, the IPv6 loopback (RFC 4291 §2.5.3). `new URL()` reports IPv6 hosts bracketed, so the
 *   brackets are stripped before comparing.
 *
 * Deliberately NOT loopback: private LAN ranges (10/8, 172.16/12, 192.168/16) and mDNS `*.local`
 * names — traffic to those crosses a real network, where plaintext is really exposed. `0.0.0.0` is
 * a wildcard bind address rather than a host any client can reach, so it is excluded too.
 */
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * PUBLIC_BASE_URL → the OpenAPI document's `servers[0].url`. Unlike PORT and DB_POOL_MAX, a wrong
 * value here has no safe fallback: it is a published contract, and silently serving `/` in its
 * place would hand every consumer a document that resolves against whatever host they happen to
 * have loaded. So this one REJECTS rather than falls back.
 *
 * - unset/blank → the relative `/` default, which is what local development runs with;
 * - `/` stays `/` — it is not an absolute URL and never reaches `new URL()`;
 * - anything else must parse as an absolute URL (a bare hostname is the common mistake, and it is
 *   an error, not a base URL);
 * - a trailing slash is stripped: `servers[0].url` is joined with paths that already start with
 *   `/`, so leaving it produces `//v1/opportunities`.
 * - the scheme must be `https:` for every host that is not loopback (see `isLoopbackHost`). This
 *   value is not merely how this process is reached — it is what the published document tells
 *   every client to use, so a plaintext remote origin downgrades all of them at once. The rule is
 *   about the transport, not about any particular domain, so it holds for a proxy, a preview
 *   environment and a vendor host alike.
 */
export function readPublicBaseUrl(raw: string | undefined, fallback = "/"): string {
  const value = (raw ?? "").trim();
  if (!value) return fallback;
  if (value === "/") return "/";

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      `PUBLIC_BASE_URL must be an absolute URL (e.g. https://api.example.org) or "/", got ${JSON.stringify(value)}.`,
    );
  }

  if (url.protocol !== "https:" && !isLoopbackHost(url.hostname)) {
    throw new Error(
      `PUBLIC_BASE_URL must use https:// for any host that is not loopback — it is published as the OpenAPI document's servers[0].url, so it tells every client which scheme to use. Got ${JSON.stringify(value)}.`,
    );
  }

  return url.href.replace(/\/+$/, "");
}

export const config: AppConfig = {
  databaseUrl:
    process.env.DATABASE_URL ??
    (isProduction ? "" : "postgres://rfphub:rfphub@localhost:5432/rfphub"),
  port: readPort(process.env.PORT),
  host: process.env.HOST ?? "0.0.0.0",
  sourceApiUrl: process.env.SOURCE_API_URL ?? "",
  sourceSystem: process.env.SOURCE_SYSTEM ?? "fundingmap",
  publicBaseUrl: readPublicBaseUrl(process.env.PUBLIC_BASE_URL),
  dbPoolMax: readDbPoolMax(process.env.DB_POOL_MAX),
};
