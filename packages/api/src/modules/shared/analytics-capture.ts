/**
 * The one call a controller makes to count something.
 *
 * It is a free function rather than a method on the buffer so the exclusion rule — "is this request
 * countable at all" — is applied in exactly one place, on the way in, and cannot be forgotten by the
 * next controller that wants to record an event. The context it reads is computed lazily
 * (`plugins/analytics-context.ts`), so a request that is never counted never pays for the hashes.
 *
 * NEVER THROWS, NEVER AWAITS. A public read must not fail, or slow down, because a metric could not
 * be written. Everything past this point is best-effort and every surface that serves the numbers
 * says so.
 */
import type { FastifyRequest } from "fastify";
import { type AnalyticsEventType, analyticsEvents } from "../services/insights/event-buffer.js";

export function captureViews(
  request: FastifyRequest,
  eventType: AnalyticsEventType,
  publicIds: string[],
): void {
  if (publicIds.length === 0) return;
  // A HEAD serves the GET route and then discards the body, so nothing was read and — on the two
  // redirects — nobody left for the programme's page. Counting one would put link checkers,
  // preview crawlers and uptime monitors into the single number a publisher is given about
  // whether their listing works.
  if (request.method === "HEAD") return;
  const context = request.analyticsContext;
  if (!context.countable) return;

  const occurredAt = new Date();
  analyticsEvents.record(
    publicIds.map((publicId) => ({
      publicId,
      eventType,
      occurredAt,
      sessionHash: context.sessionHash,
      ipHash: context.ipHash,
      referrer: context.referrer,
    })),
  );
}
