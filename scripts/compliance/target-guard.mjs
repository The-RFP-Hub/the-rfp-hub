/**
 * Which deployments may be WRITTEN to. DEFAULT-DENY against an explicit allowlist of this
 * project's staging origins plus loopback, and NO FLAG FORCES PRODUCTION.
 *
 * Not a hostname heuristic: "does any segment read like a non-production environment" admits
 * `not-staging-anymore`, `production-staging` and any CNAME an attacker controls. Hostname text
 * cannot prove which deployment answers, so the redirect chain is followed and re-checked too.
 */
import { isLoopbackHost, request } from "./http.mjs";

export { isLoopbackHost };

/** The project's real staging origins, from `.github/workflows/*staging*.yml` and `adr/0007`. */
export const STAGING_ORIGINS = ["https://staging.ethrfps.app", "https://api-staging.ethrfps.app"];

/** So a refusal can say "that is production", not just "that is not on the list". */
export const PRODUCTION_HOSTS = ["ethrfps.app", "api.ethrfps.app", "www.ethrfps.app"];

export const EXTRA_ORIGIN_ENV = "RFPHUB_ACCEPT_EXTRA_STAGING_ORIGIN";

export function normalizeOrigin(raw) {
  let url;
  try {
    url = new URL(String(raw ?? "").trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return null;
  const defaultPort = url.protocol === "https:" ? "443" : "80";
  const port = url.port && url.port !== defaultPort ? `:${url.port}` : "";
  return { origin: `${url.protocol}//${host}${port}`, protocol: url.protocol, host };
}

/** https, and a label naming staging: one carrying `prod` is not made safe by also saying staging. */
export function namesStaging(host) {
  const labels = host.split(".");
  if (labels.some((label) => label.includes("prod"))) return false;
  return labels.some(
    (label) => label === "staging" || label.startsWith("staging-") || label.endsWith("-staging"),
  );
}

export function allowedOrigins(env = process.env) {
  const allowed = [...STAGING_ORIGINS];
  const extra = normalizeOrigin(env[EXTRA_ORIGIN_ENV]);
  if (extra && extra.protocol === "https:" && namesStaging(extra.host)) allowed.push(extra.origin);
  return allowed;
}

export function targetRefusal(api, env = process.env) {
  const parsed = normalizeOrigin(api);
  if (!parsed) {
    return `--api must be an absolute http(s) URL with no userinfo, got "${api}"`;
  }
  if (isLoopbackHost(parsed.host)) return null;
  if (parsed.protocol !== "https:") {
    return `${parsed.origin} is not https, and this tool sends a live publisher credential — only loopback may be plaintext`;
  }
  const allowed = allowedOrigins(env);
  if (allowed.includes(parsed.origin)) return null;
  const production = PRODUCTION_HOSTS.includes(parsed.host)
    ? `${parsed.origin} is PRODUCTION. `
    : "";
  return `${production}${parsed.origin} is not an allowed write target. This tool submits real entries, so it accepts only loopback or ${allowed.join(", ")}. There is no flag to force production; add another staging origin with ${EXTRA_ORIGIN_ENV}=<https origin whose hostname carries a "staging" label>`;
}

/** Refuse when the redirect chain leaves the allowlist: a CNAME passes every hostname rule there is. */
export async function redirectRefusal(api, { timeoutMs = 10000, env = process.env } = {}) {
  let target = `${api}/v1/health`;
  for (let hop = 0; hop < 5; hop++) {
    const res = await request(target, { timeoutMs });
    if (!res.ok) return null; // a transport failure is the run's problem to report, not a refusal
    if (res.status < 300 || res.status >= 400 || !res.location) return null;
    let next;
    try {
      next = new URL(res.location, target).href;
    } catch {
      return `${target} redirects to an unparseable Location "${res.location}"`;
    }
    const refusal = targetRefusal(next, env);
    if (refusal) return `${api} redirects to ${next}, and ${refusal}`;
    target = next;
  }
  return `${api} redirects more than 5 times — the origin that finally answers cannot be established`;
}
