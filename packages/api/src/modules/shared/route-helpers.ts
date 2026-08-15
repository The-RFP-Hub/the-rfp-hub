/**
 * The two things every M3 route needs and neither Fastify nor the services should own.
 *
 * `handled` turns a service's `HttpError` into the response it already described. It is a wrapper
 * rather than a global error hook on purpose: a reply sent from the handler is serialized against
 * the route's declared response schema for that status, so a route that documents a richer error
 * component (a validation failure carrying `errors`, a source-key collision carrying `conflict`)
 * actually serves those members instead of having them dropped. Anything that is NOT an `HttpError`
 * is re-thrown untouched — an unexpected failure is a 500 that gets logged, and swallowing it here
 * would turn a bug into a misleading 4xx.
 *
 * `paramsOf`/`bodyOf`/`queryOf` are typed accessors. The submissions plugin runs a PASS-THROUGH
 * validator (D-7), so a Fastify request generic there would be a claim about a body nothing
 * checked; reading through a named accessor keeps the cast in one place and visible.
 */
import type { FastifyReply, FastifyRequest, RouteHandlerMethod } from "fastify";
import { isHttpError, notFound } from "./http-error.js";

export type Handler = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

export function handled(handler: Handler): RouteHandlerMethod {
  return async function wrapped(request: FastifyRequest, reply: FastifyReply) {
    try {
      return await handler(request, reply);
    } catch (error) {
      if (isHttpError(error)) {
        return reply.code(error.status).send(error.toBody());
      }
      throw error;
    }
  } as RouteHandlerMethod;
}

export function paramsOf<T>(request: FastifyRequest): T {
  return request.params as T;
}

export function bodyOf<T>(request: FastifyRequest): T {
  return (request.body ?? {}) as T;
}

export function queryOf<T>(request: FastifyRequest): T {
  return (request.query ?? {}) as T;
}

/** A path segment that must be a positive integer id, or a 404 (never a 500 from a bad parse). */
export function idParam(raw: string, what: string): number {
  const id = Number(raw);
  // A 404 rather than a 400: "that is not a number" and "there is no such row" are the same fact
  // to a caller holding a stale id, and the narrower answer distinguishes ids that could exist.
  if (!Number.isInteger(id) || id <= 0) throw notFound(`no ${what} ${JSON.stringify(raw)}.`);
  return id;
}
