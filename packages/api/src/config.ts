/**
 * Runtime configuration of the SERVER, read from the environment with local-friendly defaults.
 *
 * Only what the running service actually needs is here. Ingest-side settings are deliberately
 * absent: the seed loader takes a corpus file as its argument and reads no environment pointer at
 * all, and the one variable that names an upstream (SOURCE_API_URL) is read directly by
 * `tools/converter/fetch-corpus.ts`, an offline tool nothing on a request or seed path invokes. A
 * variable declared here is a variable every deployment has to reason about — so a variable no
 * request path reads does not belong here.
 */
import { config as loadDotenv } from "dotenv";
import { isLoopbackHost } from "./shared/loopback.js";

// Load .env (from the working directory — packages/api for every pnpm script here) before any
// process.env read below. dotenv never overwrites variables that already reached the process, so
// exported shell vars and a deployment's injected environment always win over the file.
loadDotenv({ quiet: true });

export interface AppConfig {
  databaseUrl: string;
  port: number;
  host: string;
  /**
   * Base URL the OpenAPI document advertises as its `servers[0].url` (see plugins/swagger.ts).
   * Defaults to `/` — relative, and therefore correct wherever the server happens to be reachable,
   * which is what local development runs with.
   *
   * In a deployed environment this is the API's OWN origin, never the apex: the apex is the
   * specification's origin, and the Standard's canonical documents and their identifiers are owned
   * by `packages/standard` — no route in this package answers those paths. Pointing
   * `servers[0].url` at the apex would advertise the wrong host for every API operation.
   *
   * The apex reservation (`plugins/apex-host.ts`) reads the same value for the same reason: when it
   * refuses a request on the apex it has to say where the API actually is, and the one URL it must
   * never name is the Standard's `baseUrl`, which IS the host that just refused. At the `/` default
   * the deployment has told us nothing, so the denial says "a different host" rather than guessing.
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

const LOCAL_DATABASE_URL = "postgres://rfphub:rfphub@localhost:5432/rfphub";

/**
 * Off the production path the fallback stands — but it announces itself: with the dotenv load
 * above, a DATABASE_URL that is still unset here means no exported variable AND no .env next to
 * this package's package.json, which is otherwise indistinguishable from one nobody meant to set.
 * Admin commands run from a laptop don't set NODE_ENV, so the fail-fast above is not the thing
 * that catches them.
 *
 * Module scope, so it prints at most once per process no matter how many modules import `config`.
 * The credentials are left out of the line: it names the target, it is not a copyable value.
 */
if (!isProduction && !process.env.DATABASE_URL) {
  console.error(
    "DATABASE_URL unset — using the local docker-compose default postgres://rfphub@localhost:5432/rfphub (no packages/api/.env found and nothing exported; copy .env-example to .env to point elsewhere).",
  );
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
  databaseUrl: process.env.DATABASE_URL ?? (isProduction ? "" : LOCAL_DATABASE_URL),
  port: readPort(process.env.PORT),
  host: process.env.HOST ?? "0.0.0.0",
  publicBaseUrl: readPublicBaseUrl(process.env.PUBLIC_BASE_URL),
  dbPoolMax: readDbPoolMax(process.env.DB_POOL_MAX),
};
