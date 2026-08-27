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

export interface McpConfig {
  /** Base URL for `/v1/...` paths, with any trailing slash removed. */
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

/** Canonical origin: lowercased scheme and host, port only when it is not the scheme default. */
export function canonicalOrigin(base: string): string {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new ConfigError(
      `RFPHUB_API_BASE is not a valid absolute URL: ${JSON.stringify(base)}. ` +
        `Example: ${DEFAULT_API_BASE}`,
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigError(`RFPHUB_API_BASE must be http or https, not ${url.protocol}`);
  }
  // `URL.origin` already drops a default port and lowercases the host.
  return url.origin;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): McpConfig {
  const apiBase = (env.RFPHUB_API_BASE?.trim() || DEFAULT_API_BASE).replace(/\/+$/, "");
  const apiKeyRaw = env.RFPHUB_API_KEY?.trim();
  return {
    apiBase,
    apiOrigin: canonicalOrigin(apiBase),
    apiKey: apiKeyRaw ? apiKeyRaw : null,
    submitEnabled: env.RFPHUB_MCP_ENABLE_SUBMIT === "1",
    home: env.RFPHUB_MCP_HOME?.trim() || path.join(os.homedir(), ".rfphub"),
  };
}
