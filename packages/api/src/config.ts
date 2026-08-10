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
   * Defaults to `/` (relative — correct for Swagger UI regardless of where it's hosted).
   *
   * In a deployed environment this is the API's OWN origin, always `https://` (the domain is on
   * the HSTS preload list, so there is no plaintext variant to fall back to):
   *
   *   production  https://api.ethrfps.app
   *   staging     https://api-staging.ethrfps.app
   *
   * It is NOT the apex. The apex is the specification's origin: the Standard's canonical
   * documents and their identifiers are owned by `packages/standard`, and no route in this
   * package answers those paths. Pointing `servers[0].url` at the apex would advertise the
   * wrong host for every API operation.
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
 * templated-but-unsupplied env var in a compose file or a k8s ConfigMap — would otherwise bind an
 * OS-assigned ephemeral port while the image still publishes 3001. Anything that is not a whole
 * port number in 1..65535 is treated the same way.
 */
export function readPort(raw: string | undefined, fallback = DEFAULT_PORT): number {
  const parsed = Number((raw ?? "").trim());
  const usable = Number.isInteger(parsed) && parsed > 0 && parsed <= 65535;
  return usable ? parsed : fallback;
}

const port = readPort(process.env.PORT);

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

const dbPoolMax = readDbPoolMax(process.env.DB_POOL_MAX);

export const config: AppConfig = {
  databaseUrl:
    process.env.DATABASE_URL ??
    (isProduction ? "" : "postgres://rfphub:rfphub@localhost:5432/rfphub"),
  port,
  host: process.env.HOST ?? "0.0.0.0",
  sourceApiUrl: process.env.SOURCE_API_URL ?? "",
  sourceSystem: process.env.SOURCE_SYSTEM ?? "fundingmap",
  sourceProgramUrlBase: process.env.SOURCE_PROGRAM_URL_BASE ?? "",
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? "/",
  dbPoolMax,
};
