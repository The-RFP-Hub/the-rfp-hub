/**
 * Everything the server is configured with, resolved once. Only two things come from the
 * environment: the credential — deliberately not a tool parameter, because a model that can put a
 * key in an argument can put it in a transcript — and the deployment's base URL. Everything else
 * is a flag or a constant. `apiOrigin` is separate because the approval binds to it: a trailing
 * slash, an explicit `:443` and an upper-case host are one destination and must produce one
 * approval.
 */
import os from "node:os";
import path from "node:path";

/** The production API. Overridable for staging and for the integration tests. */
export const DEFAULT_API_BASE = "https://api.ethrfps.app";

/**
 * How long any one API request — headers and body together — may take. Fixed: a deadline an
 * operator can raise is a deadline a stalled destination can hold a tool call open behind.
 */
export const DEFAULT_TIMEOUT_MS = 20_000;

/** Where approvals, rate-limit counters and the audit log live unless `--state-dir` says otherwise. */
export function defaultStateDir(): string {
  return path.join(os.homedir(), ".rfphub");
}

export interface McpConfig {
  /** Base URL for `/v1/...` paths. Always a bare canonical origin — see `canonicalOrigin`. */
  apiBase: string;
  /** Canonical origin of `apiBase` — scheme + host + non-default port. Bound into the approval. */
  apiOrigin: string;
  /** The `rfph_` credential, or null when none is configured. Reads never send it. */
  apiKey: string | null;
  /** Directory for the approval, policy-counter and audit files. 0700. */
  home: string;
  /** Per-request deadline in milliseconds. */
  timeoutMs: number;
}

export class ConfigError extends Error {}

/** A HASH prefix, not a key prefix: it identifies "the same key" without carrying any of it. */
export function keyFingerprint(key: string | null, sha256Hex: (s: string) => string): string {
  if (key === null) return "none";
  return sha256Hex(key).slice(0, 8);
}

/** The only hosts reachable over plain `http:`; the write path sends a bearer credential. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

function isLoopback(hostname: string): boolean {
  // `URL` lowercases the host; the trailing dot of a fully qualified name is the same host.
  const host = hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
  return LOOPBACK_HOSTS.has(host);
}

const SCHEME_RULE =
  "RFPHUB_API_BASE must use https, except for the loopback hosts 127.0.0.1, [::1] and localhost. " +
  "The credential travels on the write request, and plain http would put it on the wire in the clear.";

const SHAPE_RULE =
  "RFPHUB_API_BASE must be a bare origin — scheme, host and optional port, nothing else. A path, " +
  "query or fragment is refused because the write approval binds the ORIGIN, so two bases that " +
  "differ only after the host would produce the same approval and reach different endpoints.";

/** NO FAILURE HERE ECHOES THE VALUE: `https://user:pw@host` is an easy accident, and the message
 * reaches stderr, an audit line and the model's context. */
function parseBase(base: string): URL {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new ConfigError(
      `RFPHUB_API_BASE is not a valid absolute URL. Example: ${DEFAULT_API_BASE}. The value is not repeated here in case it carries a credential.`,
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigError(`RFPHUB_API_BASE must be http or https, not ${url.protocol}`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new ConfigError(
      "RFPHUB_API_BASE must not carry a username or password. The credential is read from " +
        "RFPHUB_API_KEY and is sent as a bearer token; a URL that embeds one would put it in " +
        "every diagnostic this server writes. The value is not repeated here.",
    );
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new ConfigError(`${SHAPE_RULE} Got ${url.origin} followed by more.`);
  }
  if (url.protocol !== "https:" && !isLoopback(url.hostname)) {
    throw new ConfigError(`${SCHEME_RULE} Got ${url.protocol}//${url.host}.`);
  }
  return url;
}

/** Canonical origin: lowercased scheme and host, port only when it is not the scheme default. */
export function canonicalOrigin(base: string): string {
  // `URL.origin` already drops a default port and lowercases the host.
  return parseBase(base).origin;
}

export interface LoadConfigOptions {
  /** `--state-dir`. A container with no writable home has no other way to say where state goes. */
  stateDir?: string | undefined;
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: LoadConfigOptions = {},
): McpConfig {
  const apiOrigin = canonicalOrigin(env.RFPHUB_API_BASE?.trim() || DEFAULT_API_BASE);
  const apiKeyRaw = env.RFPHUB_API_KEY?.trim();
  const stateDir = options.stateDir?.trim();
  return {
    apiBase: apiOrigin,
    apiOrigin,
    apiKey: apiKeyRaw ? apiKeyRaw : null,
    home: stateDir ? path.resolve(stateDir) : defaultStateDir(),
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
}
