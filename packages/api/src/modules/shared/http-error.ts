/**
 * A service-layer failure that already knows its HTTP shape.
 *
 * The services below the routes decide almost every 4xx this API emits — "that namespace is not
 * yours", "that id already exists with different content", "that key belongs to somebody else" —
 * and each of those answers belongs with the rule that produced it, not restated in a controller
 * that would eventually disagree with it.
 *
 * `code` is the STABLE machine-readable half (`{error: "<code>", message}`) and is part of the
 * published contract; `message` is for a human and may be reworded. `details` carries the extra
 * members a specific error contract declares — `errors` on a validation failure, `conflict` on a
 * source-key collision — and is spread into the body, so a route that declares a richer error
 * component serves it and a route that declares the plain `ErrorResponse` has it dropped by the
 * serializer rather than leaking an undocumented field.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "HttpError";
  }

  /** The response body, in the `{error, message, …}` shape every error in this API uses. */
  toBody(): Record<string, unknown> {
    return { error: this.code, message: this.message, ...this.details };
  }
}

export function isHttpError(error: unknown): error is HttpError {
  return error instanceof HttpError;
}

export const badRequest = (code: string, message: string, details?: Record<string, unknown>) =>
  new HttpError(400, code, message, details);
export const unauthorized = (message: string) => new HttpError(401, "unauthorized", message);
export const forbidden = (code: string, message: string) => new HttpError(403, code, message);
export const notFound = (message: string) => new HttpError(404, "not_found", message);
export const conflict = (code: string, message: string, details?: Record<string, unknown>) =>
  new HttpError(409, code, message, details);
