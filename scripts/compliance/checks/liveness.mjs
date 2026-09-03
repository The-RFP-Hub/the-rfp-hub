/**
 * Criterion 1 — API liveness.
 *
 * `GET {base}/v1/health` answers 200 and reports itself healthy, the transport is TLS and the
 * certificate is valid, and the round trip is timed.
 *
 * Health is checked as the SERVICE defines it, not as this script wishes it were: the endpoint
 * answers `{status:"ok", db:"up"}` when the database is reachable and 503 `{status:"degraded",
 * db:"down"}` when it is not (packages/api health.controller.ts). A 200 whose body says `degraded`
 * is therefore a failure here, because the criterion is "is 200 AND healthy".
 */
import { url, asJson, isLoopbackHost, probeTls, request } from "../http.mjs";

const SAMPLES = 3;

export async function checkLiveness(report, ctx) {
  const c = report.criterion(
    "liveness",
    "API liveness",
    "GET {base}/v1/health answers 200 and healthy, over a valid TLS transport, within a reported time.",
  );

  const target = url(ctx.api, "/v1/health");
  const parsed = new URL(ctx.api);
  const loopback = isLoopbackHost(parsed.hostname);

  // ── transport ────────────────────────────────────────────────────────────────────────────
  if (parsed.protocol === "https:") {
    const tls = await probeTls(ctx.api, { timeoutMs: ctx.timeoutMs });
    if (tls.valid) {
      const life =
        tls.daysRemaining === undefined
          ? "unknown remaining lifetime"
          : `${tls.daysRemaining} days left`;
      const detail = `${tls.protocol}, CN=${tls.subject ?? "?"}, issuer=${tls.issuer ?? "?"}, expires ${tls.validTo ?? "?"} (${life})`;
      c.pass("TLS certificate is valid for this host", detail, tls);
      if (typeof tls.daysRemaining === "number" && tls.daysRemaining < 21) {
        c.warn(
          "TLS certificate expires soon",
          `${tls.daysRemaining} days remaining — renew before sign-off is relied on.`,
        );
      }
    } else {
      c.fail(
        "TLS certificate is valid for this host",
        tls.error ?? "certificate was rejected",
        tls,
      );
    }
  } else if (loopback) {
    c.skip(
      "TLS certificate is valid for this host",
      `${ctx.api} is a loopback origin — plaintext never leaves the machine there, so there is no transport to verify. A deployed base URL must be https://.`,
    );
  } else if (ctx.allowInsecure) {
    c.warn(
      "TLS certificate is valid for this host",
      `${ctx.api} is plaintext on a non-loopback host and --allow-insecure was passed. This is not a signable transport.`,
    );
  } else {
    c.fail(
      "TLS certificate is valid for this host",
      `${ctx.api} is plaintext on a non-loopback host. The published base URL tells every client which scheme to speak, so http:// downgrades all of them at once. Pass --allow-insecure only for a throwaway environment.`,
    );
  }

  // ── liveness ─────────────────────────────────────────────────────────────────────────────
  const timings = [];
  let last;
  for (let i = 0; i < SAMPLES; i++) {
    last = await request(target, { timeoutMs: ctx.timeoutMs });
    if (!last.ok) break;
    timings.push(last.elapsedMs);
  }

  if (!last.ok) {
    c.fail("GET /v1/health is reachable", `${target}: ${last.error}`);
    return c.finish();
  }

  c.expect(
    last.status === 200,
    "GET /v1/health returns 200",
    `${target} → 200`,
    `${target} → ${last.status} (body: ${last.body.slice(0, 200)})`,
  );

  const sorted = [...timings].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  c.info(
    "response time",
    `${median} ms median over ${timings.length} samples (min ${sorted[0]} ms, max ${sorted[sorted.length - 1]} ms), body ${last.body.length} bytes`,
    { samplesMs: timings, medianMs: median },
  );

  const { json, error } = asJson(last);
  if (error) {
    c.fail("GET /v1/health returns a JSON body", error);
    return c.finish();
  }
  c.expect(
    last.contentType === "application/json",
    "GET /v1/health is served as application/json",
    `content-type: ${last.contentType}`,
    `content-type: ${last.contentType || "(none)"} — expected application/json`,
  );
  c.expect(
    json.status === "ok",
    "the service reports itself healthy",
    `status: ${json.status}`,
    `status: ${JSON.stringify(json.status)} — the service answers, but does not call itself healthy`,
  );
  c.expect(
    json.db === "up",
    "the service reports its database reachable",
    `db: ${json.db}`,
    `db: ${JSON.stringify(json.db)} — the API is up but its datastore is not, so every data endpoint is unreliable`,
  );

  // The root document is the service's own index of what it serves; cheap to confirm it answers.
  const root = await request(url(ctx.api, "/"), { timeoutMs: ctx.timeoutMs });
  if (root.ok && root.status === 200) {
    const parsedRoot = asJson(root).json ?? {};
    c.info(
      "service identifies itself at /",
      `${parsedRoot.name ?? "?"} ${parsedRoot.version ?? ""} (standard ${parsedRoot.standard ?? "?"}), docs at ${parsedRoot.docs ?? "?"}`,
      parsedRoot,
    );
  } else {
    c.warn("service identifies itself at /", `GET / → ${root.ok ? root.status : root.error}`);
  }

  return c.finish();
}

export const meta = {
  key: "liveness",
  requires: [],
  needs: ["api"],
  contract: { m2: "M2-1" },
};

export async function run(ctx) {
  await checkLiveness(ctx.report, ctx);
}
