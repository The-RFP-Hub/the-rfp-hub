/**
 * Everything the server reads from its ENVIRONMENT, resolved once, in one place.
 *
 * The credential is deliberately not a tool parameter and never will be: a model that can put a
 * key in an argument can also put it in a transcript, a log line, or a document it submits. It
 * comes from the process environment the person configuring the client wrote, and nothing in the
 * MCP channel can change it.
 *
 * `apiOrigin` is the CANONICAL origin of `apiBase`, and it is a separate field because the write
 * approval binds to it: `https://api.ethrfps.app`, `https://api.ethrfps.app/` and
 * `https://api.ethrfps.app:443` are the same destination and must produce the same approval, while
 * a staging host must not.
 */
import os from "node:os";
import path from "node:path";

/** The production API. Overridable for staging and for the integration tests. */
export const DEFAULT_API_BASE = "https://api.ethrfps.app";

/** How long any one API request — headers and body together — may take. */
export const DEFAULT_TIMEOUT_MS = 20_000;
export const MIN_TIMEOUT_MS = 1_000;
/** A hard ceiling: an operator may shorten the deadline, never remove it. */
export const MAX_TIMEOUT_MS = 120_000;

export interface McpConfig {
  /** Base URL for `/v1/...` paths. Always a bare canonical origin — see `canonicalOrigin`. */
  apiBase: string;
  /** Canonical origin of `apiBase` — scheme + host + non-default port. Bound into the approval. */
  apiOrigin: string;
  /** The `rfph_` credential, or null when none is configured. Reads never send it. */
  apiKey: string | null;
  /**
   * Whether the write tool is REGISTERED at all. Fail-closed: without the flag the tool does not
   * appear in `tools/list`, so a poisoned search result has no write tool to reach for.
   */
  submitEnabled: boolean;
  /** Directory for the approval, policy-counter and audit files. 0700. */
  home: string;
  /** Per-request deadline in milliseconds. */
  timeoutMs: number;
}

export class ConfigError extends Error {}

/**
 * A non-secret, stable handle for a credential: the first 8 hex characters of its SHA-256.
 *
 * It is NOT a prefix of the key. A prefix would leak key material into an approval file, an audit
 * line and a terminal an operator may screen-share; a hash prefix identifies "the same key as
 * last time" without carrying any of it.
 */
export function keyFingerprint(key: string | null, sha256Hex: (s: string) => string): string {
  if (key === null) return "none";
  return sha256Hex(key).slice(0, 8);
}

/**
 * The hosts allowed to be reached over plain `http:`.
 *
 * Nothing else may be: the write path sends `Authorization: Bearer <key>`, and a cleartext
 * credential on a network is a leaked credential no matter which origin a human approved.
 */
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

/**
 * Parse and vet `RFPHUB_API_BASE`.
 *
 * NO FAILURE HERE EVER ECHOES THE VALUE. `https://user:password@host` is a perfectly ordinary URL
 * to write by accident, and quoting the offending base back into an error message — which reaches
 * stderr, an audit line and the model's context — would publish those credentials.
 */
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

/** `RFPHUB_MCP_TIMEOUT_MS`, or the default. Out of range is refused, never silently clamped. */
export function resolveTimeoutMs(raw: string | undefined): number {
  const text = raw?.trim();
  if (text === undefined || text === "") return DEFAULT_TIMEOUT_MS;
  const value = Number(text);
  if (!Number.isInteger(value) || value < MIN_TIMEOUT_MS || value > MAX_TIMEOUT_MS) {
    throw new ConfigError(
      `RFPHUB_MCP_TIMEOUT_MS must be a whole number of milliseconds between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}; got ${JSON.stringify(text)}.`,
    );
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): McpConfig {
  const apiOrigin = canonicalOrigin(env.RFPHUB_API_BASE?.trim() || DEFAULT_API_BASE);
  const apiKeyRaw = env.RFPHUB_API_KEY?.trim();
  return {
    apiBase: apiOrigin,
    apiOrigin,
    apiKey: apiKeyRaw ? apiKeyRaw : null,
    submitEnabled: env.RFPHUB_MCP_ENABLE_SUBMIT === "1",
    // RFPHUB_MCP_HOME WINS over HOME and over `os.homedir()`: a service account or a container may
    // have no home directory at all, or one shared with something else.
    home: env.RFPHUB_MCP_HOME?.trim() || path.join(os.homedir(), ".rfphub"),
    timeoutMs: resolveTimeoutMs(env.RFPHUB_MCP_TIMEOUT_MS),
  };
}
