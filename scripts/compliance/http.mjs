/**
 * HTTP + TLS primitives for the M2 compliance checker.
 *
 * Everything here is deliberately non-throwing on the transport: a refused connection, a DNS
 * failure or an expired certificate is a RESULT the report has to render, not an exception that
 * aborts the run before the other three criteria are looked at. Only programmer errors throw.
 */
import { connect } from "node:tls";

/**
 * Hosts whose traffic never leaves the machine — the only ones allowed to be reached over
 * plaintext without `--allow-insecure`. Same rule, and same reasoning, as the API's own
 * `PUBLIC_BASE_URL` policy in packages/api/src/config.ts: loopback is the one place where there is
 * no network segment on which plaintext could be observed or tampered with. Private LAN ranges and
 * mDNS `*.local` names are deliberately NOT loopback — traffic to those crosses a real network.
 */
export function isLoopbackHost(hostname) {
  const host = String(hostname)
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/** Normalize a user-supplied base URL: parsed, trailing slashes stripped. Throws if unusable. */
export function normalizeBase(raw, flag) {
  const value = String(raw ?? "").trim();
  if (!value) throw new Error(`${flag} is required`);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      `${flag} must be an absolute URL (e.g. https://api.example.org), got "${value}"`,
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`${flag} must be http(s), got "${url.protocol}"`);
  }
  return url.href.replace(/\/+$/, "");
}

/** Join a normalized base with an absolute path. */
export function url(base, path) {
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

/** Build a query string from an object, dropping undefined values. Values may be arrays. */
export function query(params) {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    for (const v of Array.isArray(value) ? value : [value]) qs.append(key, String(v));
  }
  const s = qs.toString();
  return s ? `?${s}` : "";
}

/**
 * One request. Returns a plain result object — `{ ok: false, error }` for a transport failure,
 * otherwise the status, headers, timing and the raw body text (parsed lazily by the caller).
 *
 * `elapsedMs` measures the whole exchange including the body read, which is the number a sign-off
 * report wants: it is what a consumer waits for, not the time to first byte.
 *
 * REDIRECTS ARE NOT FOLLOWED BY DEFAULT, and that is a deliberate reversal.
 *
 * This client executes every operation the published OpenAPI document declares. Once the API
 * publishes an operation whose documented answer IS a redirect — the link-out routes, which
 * answer `302` with a `Location` — following it would fetch the destination site and judge that
 * site's `200 text/html` against a declared `302`. Every such operation would fail criterion 2,
 * and the nightly workflow fails the job on a non-zero exit. A checker that cannot tell a correct
 * redirect from a broken one is not a checker.
 *
 * `follow: true` is the opt-in, for the callers whose question really is "what is at the end of
 * this": the published export artifacts, which are served by static file hosts that redirect as a
 * matter of course, and the documentation discovery probes.
 */
export async function request(target, options = {}) {
  const { method = "GET", timeoutMs = 15000, headers = {}, follow = false, body } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = performance.now();
  try {
    const res = await fetch(target, {
      method,
      headers: { accept: "*/*", "user-agent": "rfphub-m2-compliance", ...headers },
      // Inert for every M2 caller — this client only reads. It exists because the M3 checker
      // WRITES (it submits entries and mints a key) and reuses this transport rather than
      // maintaining a second copy of the redirect, timeout and error handling above.
      ...(body === undefined ? {} : { body }),
      signal: controller.signal,
      redirect: follow ? "follow" : "manual",
    });
    const text = method === "HEAD" ? "" : await res.text();
    return {
      url: target,
      method,
      ok: true,
      status: res.status,
      headers: Object.fromEntries(res.headers.entries()),
      contentType: mediaType(res.headers.get("content-type")),
      /** Where a 3xx points. Absent on every other status. */
      location: res.headers.get("location") ?? undefined,
      /** Whether this result is the end of a redirect chain or the first hop of one. */
      followed: follow,
      body: text,
      elapsedMs: Math.round((performance.now() - startedAt) * 10) / 10,
    };
  } catch (err) {
    const aborted = err?.name === "AbortError";
    return {
      url: target,
      method,
      ok: false,
      error: aborted ? `timed out after ${timeoutMs} ms` : describeError(err),
      elapsedMs: Math.round((performance.now() - startedAt) * 10) / 10,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** A fetch failure's real cause, which node buries one level down in `cause`. */
function describeError(err) {
  const cause = err?.cause;
  const code = cause?.code ?? err?.code;
  const message = cause?.message ?? err?.message ?? String(err);
  return code ? `${message} (${code})` : message;
}

/** The essence of a Content-Type header — media type only, parameters dropped, lowercased. */
export function mediaType(value) {
  if (!value) return "";
  return String(value).split(";")[0].trim().toLowerCase();
}

/** Parse a response body as JSON, returning `{ json }` or `{ error }`. Never throws. */
export function asJson(res) {
  try {
    return { json: JSON.parse(res.body) };
  } catch (err) {
    return { error: `body is not valid JSON: ${err.message}` };
  }
}

/**
 * Inspect the TLS certificate an https origin presents.
 *
 * `fetch` already refuses an untrusted or expired certificate — a TLS failure surfaces as a
 * transport error on every other check in the run. This probe exists to say something the
 * transport error cannot: WHICH certificate is being served, by whom, and how long it has left.
 * A certificate three days from expiry passes every request today and takes the deployment down
 * on Thursday, so remaining lifetime is reported, and a short one is a warning.
 */
export async function probeTls(target, { timeoutMs = 15000 } = {}) {
  const parsed = new URL(target);
  if (parsed.protocol !== "https:") return { applicable: false, protocol: parsed.protocol };
  const port = Number(parsed.port || 443);
  const host = parsed.hostname.replace(/^\[|\]$/g, "");

  return await new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    const socket = connect(
      { host, port, servername: host, rejectUnauthorized: true, timeout: timeoutMs },
      () => {
        const cert = socket.getPeerCertificate(false) ?? {};
        const validTo = cert.valid_to ? new Date(cert.valid_to) : undefined;
        const daysRemaining =
          validTo && !Number.isNaN(validTo.getTime())
            ? Math.floor((validTo.getTime() - Date.now()) / 86_400_000)
            : undefined;
        done({
          applicable: true,
          valid: socket.authorized,
          error: socket.authorized ? undefined : socket.authorizationError?.message,
          protocol: socket.getProtocol(),
          subject: cert.subject?.CN,
          altNames: cert.subjectaltname,
          issuer: cert.issuer?.O ?? cert.issuer?.CN,
          validFrom: cert.valid_from,
          validTo: cert.valid_to,
          daysRemaining,
        });
      },
    );
    socket.on("timeout", () =>
      done({ applicable: true, valid: false, error: "TLS handshake timed out" }),
    );
    socket.on("error", (err) =>
      done({ applicable: true, valid: false, error: describeError(err) }),
    );
  });
}

/** Run `worker` over `items` with a bounded number in flight. Results keep input order. */
export async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}
