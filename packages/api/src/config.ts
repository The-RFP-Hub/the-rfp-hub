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
   * Base URL for a program's page on the upstream source. Used as the last-resort
   * `applicationUrl` when a program publishes no submission or website URL — the re-cut removed
   * `source.url`, making `applicationUrl` the only link-back target. Deployment-specific — set
   * via SOURCE_PROGRAM_URL_BASE.
   */
  sourceProgramUrlBase: string;
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
 * The project's own domain. It is the ONLY host whose scheme this file constrains: the domain is on
 * the HSTS preload list, so a plaintext origin under it is one no browser will ever actually use —
 * publishing it in `servers[0].url` would send every "Try it out" request in the docs to a URL that
 * is rewritten out from under it. Any other host (localhost, a preview environment, a proxy) is
 * left alone, because nothing here knows their transport.
 */
const OWN_DOMAIN = "ethrfps.app";

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
      `PUBLIC_BASE_URL must be an absolute URL (e.g. https://api.${OWN_DOMAIN}) or "/", got ${JSON.stringify(value)}.`,
    );
  }

  const host = url.hostname.toLowerCase();
  if ((host === OWN_DOMAIN || host.endsWith(`.${OWN_DOMAIN}`)) && url.protocol !== "https:") {
    throw new Error(
      `PUBLIC_BASE_URL must use https:// for ${OWN_DOMAIN} (the domain is HSTS-preloaded, so there is no plaintext variant to advertise), got ${JSON.stringify(value)}.`,
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
  sourceProgramUrlBase: process.env.SOURCE_PROGRAM_URL_BASE ?? "",
  publicBaseUrl: readPublicBaseUrl(process.env.PUBLIC_BASE_URL),
  dbPoolMax: readDbPoolMax(process.env.DB_POOL_MAX),
};
