/**
 * The per-request analytics context — and the deliberate decision that this plugin does NOT capture.
 *
 * An `onResponse` hook was the obvious place to count a read, and it cannot work: the ids in a list
 * response exist only in the service's result, which the controller hands straight to `res.send`.
 * A response hook sees a serialized payload and a URL, so it could count "somebody listed something"
 * and nothing more. So capture is an explicit call in the controllers, where the ids are, and this
 * plugin only supplies the part every capture needs: who, roughly, and whether to count them at all.
 *
 * THREE PROPERTIES, EACH ONE A DECISION:
 *
 * 1. **Hashes are keyed HMACs, not digests.** The IPv4 space is four billion candidates; a plain
 *    `sha256(salt + ip)` with a known salt is a reversible encoding of an address. The key arrives
 *    at runtime and never enters an image, and the UTC date is part of the input, so the effective
 *    key rotates daily and yesterday's token cannot be joined to today's.
 * 2. **Lazy.** The context costs two HMACs, and the overwhelming majority of requests to this API
 *    are not counted at all (feeds, exports, the spec documents, anything from our own automation).
 *    Computing it on a getter means those requests pay nothing.
 * 3. **`countable` is decided here, once.** The nightly exporter and the compliance checker both
 *    identify themselves and are excluded BY NAME — without that, every publisher's view count is
 *    mostly us, every night, against production. `DNT: 1` and a conservative bot pattern are
 *    honoured for the same reason: the numbers are labelled best-effort, and a smaller honest one is
 *    worth more than a bigger one made of robots.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { config as defaultConfig } from "../config.js";
import {
  ipHash,
  isCountableRequest,
  referrerHost,
  sessionHash,
} from "../modules/shared/analytics-hash.js";

export interface AnalyticsContext {
  /** False for our own automation, a crawler, or a reader who asked not to be counted. */
  countable: boolean;
  sessionHash: string | null;
  ipHash: string | null;
  /** Host only. */
  referrer: string | null;
}

const NOT_COUNTED: AnalyticsContext = {
  countable: false,
  sessionHash: null,
  ipHash: null,
  referrer: null,
};

/** Build the context for one request. Exported so the capture unit tests need no Fastify. */
export function analyticsContextOf(
  request: Pick<FastifyRequest, "headers" | "ip">,
  options: { key: string; enabled: boolean; now?: Date },
): AnalyticsContext {
  if (!options.enabled) return NOT_COUNTED;
  const userAgent = headerOf(request.headers["user-agent"]);
  const dnt = headerOf(request.headers.dnt);
  if (!isCountableRequest(userAgent, dnt)) return NOT_COUNTED;

  const at = options.now ?? new Date();
  // `request.ip` is only ever the forwarded address when `TRUST_PROXY` names the proxy in front of
  // this process (config.ts refuses the blanket `true`), so this is not a client-chosen value.
  const address = request.ip ?? "";
  return {
    countable: true,
    sessionHash: sessionHash(options.key, address, userAgent ?? "", at),
    ipHash: ipHash(options.key, address, at),
    referrer: referrerHost(headerOf(request.headers.referer)) ?? null,
  };
}

function headerOf(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Decorate every request with a lazily-computed `analyticsContext`.
 *
 * Registered on the ROOT instance like the auth decorators, and for the same reason: every route
 * module has to be able to read it, and Fastify encapsulation would otherwise scope it to whichever
 * plugin declared it.
 */
export function registerAnalyticsContext(
  app: FastifyInstance,
  options: { key?: string; enabled?: boolean } = {},
): void {
  const key = options.key ?? defaultConfig.analytics.hmacKey;
  const enabled = options.enabled ?? defaultConfig.analytics.enabled;

  // Declared so the property exists on the shared request shape rather than being added later.
  app.decorateRequest("analyticsContextCache", null);
  app.decorateRequest("analyticsContext", {
    getter(this: FastifyRequest): AnalyticsContext {
      const cached = this.analyticsContextCache;
      if (cached) return cached;
      const context = analyticsContextOf(this, { key, enabled });
      this.analyticsContextCache = context;
      return context;
    },
  });
}
