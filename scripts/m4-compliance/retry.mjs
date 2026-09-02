/**
 * One retry for the probes that ask GitHub whether a document is published.
 *
 * A sign-off run failed M4-1 with HTTP 502 on all four governance URLs; every one answered 200
 * moments later. GitHub rate-limits and occasionally 502s a burst, and a transient gateway error
 * is not evidence that a document is unpublished — which is the only thing these probes are for.
 *
 * Deliberately narrow: one retry, a short fixed backoff, and only for a transport failure or a 5xx
 * from a host that serves this project's published documents. A 4xx is never retried — a 404 IS
 * the answer, and repeating it would only make an honest red run slower.
 */
import { request } from "../m2-compliance/http.mjs";

export const RETRY_HOSTS = ["github.com", "raw.githubusercontent.com"];
export const RETRY_BACKOFF_MS = 2000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A transport failure or a 5xx, from a host worth asking twice. */
export function isRetryable(target, res, retryHosts = RETRY_HOSTS) {
  let host;
  try {
    host = new URL(target).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (!retryHosts.includes(host)) return false;
  return !res.ok || res.status >= 500;
}

/** `request`, retried once. Returns the second result when there is one, else the first. */
export async function requestPublished(target, options = {}, retry = {}) {
  const { retryHosts = RETRY_HOSTS, backoffMs = RETRY_BACKOFF_MS } = retry;
  const first = await request(target, options);
  if (!isRetryable(target, first, retryHosts)) return first;
  await sleep(backoffMs);
  return await request(target, options);
}
