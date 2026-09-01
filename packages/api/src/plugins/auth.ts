/**
 * Authentication and the four authorization gates, decorated on the ROOT instance.
 *
 * Registered like `plugins/apex-host.ts` — a plain function called on the root app rather than an
 * encapsulated plugin — because these decorators must be visible to every route module, and
 * Fastify encapsulation would otherwise scope them to whatever plugin declared them.
 *
 * The gates, and what each one closes:
 *
 *   `requireAuth`     a credential of either kind. 401 without one.
 *   `requireSession`  a real SESSION, API keys refused with 403. This is what keeps a leaked key
 *                     from minting a stronger key, changing the account's identity, approving
 *                     anything or granting itself a role — see `capabilities.canManageKeys`.
 *   `requireScope`    an explicit scope on an API-key credential (a session always passes: a
 *                     session is the account itself, not a scoped delegation of it).
 *   `requireRole`     a global role AND a session, because T3/T4 are session-only by D-4.
 *
 * A PRESENTED-BUT-INVALID credential is always a 401, including on the optional gate. Ignoring one
 * and serving the anonymous view would mean a caller with an expired token silently sees less than
 * they asked for, and never learns why.
 *
 * RESOLVING IS SPLIT FROM REJECTING, and the split is what makes anonymous traffic meterable.
 * Every gate above ANSWERS — `reply.send(401)` — and answering ends the hook chain it is running
 * in, so anything registered after it never runs. A rate limiter registered after `requireAuth`
 * therefore never saw a request with a bad credential: hammering a write route with a junk Bearer
 * cost nothing. `resolvePrincipal` is the same resolution WITHOUT the answer — it populates
 * `request.principal` when the credential is good, records why it was refused when it is not, and
 * replies to nothing at all. Put it first, meter second, gate third, and the refusal still happens,
 * one hook later, after the request has been counted.
 *
 * `unavailable` IS A SEPARATE ARM BECAUSE ONLY ONE OF THE TWO MAY BE COUNTED. A 5xx is OUR failure,
 * not a verdict on the caller: `SessionService.verify` answers 503 `auth_unavailable` when the
 * lookup could not be PERFORMED, so that an outage does not appear as every signed-in user's
 * session being invalid. Metering it would re-collapse that distinction one layer up — the outage
 * would spend the caller's budget and, past the ceiling, be served as 429. The limiter reads this
 * arm and skips the increment (`meteredAuth`'s `allowList` in
 * `modules/routes/shared/rate-limit-key.ts`); the gate behind it then sends the preserved 5xx.
 *
 * The outcome is cached on the request (`request.principalResolution`), so a chain that resolves
 * and then gates verifies the credential ONCE — one session lookup or one key hash, as before.
 */
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  onRequestAsyncHookHandler,
  preHandlerHookHandler,
} from "fastify";
import { type Auth, type AuthConfig, defaultAuth } from "../auth/better-auth.js";
import { type DB, db as defaultDb } from "../db/client.js";
import { AccountService } from "../modules/services/auth/account.service.js";
import { ApiKeyService } from "../modules/services/auth/api-key.service.js";
import {
  PrincipalService,
  type RequestPrincipal,
} from "../modules/services/auth/principal.service.js";
import { SessionService } from "../modules/services/auth/session.service.js";
import type { AccountRole, ApiKeyScope } from "../modules/shared/capabilities.js";
import { isHttpError } from "../modules/shared/http-error.js";

export interface AuthOptions {
  /**
   * Overrides the deployment's session authority — the integration suites inject their own
   * instance, over the test database, so they can sign identities in without a network or a
   * third party. ONE optional constructor override is the whole seam.
   */
  auth?: Auth;
  /**
   * The auth-side configuration the MOUNT reads — allowed origins, the API's own URL. Separate
   * from `auth` because it answers a different question: `auth` is what verifies a token, this is
   * who may ask it to mint one. A test that exercises the CORS split supplies both.
   */
  config?: AuthConfig;
  db?: DB;
}

export interface AuthDecorators {
  /**
   * The instance the verifier resolved against — handed back so the HTTP mount uses the SAME one.
   * Two instances over one database would verify each other's tokens only by accident of sharing a
   * secret, and would diverge the moment one was injected by a test.
   */
  auth: Auth;
  principals: PrincipalService;
  /**
   * Resolve the request's credential and answer NOTHING — the half of a gate that is safe to run
   * before a rate limiter. Sets `request.principal` for a valid Bearer, records why an invalid one
   * was refused, and never sends, throws or ends the chain. A gate placed after it still refuses;
   * it just refuses one hook later, with the request counted.
   */
  resolvePrincipal: onRequestAsyncHookHandler;
  requireAuth: preHandlerHookHandler;
  requireSession: preHandlerHookHandler;
  optionalAuth: preHandlerHookHandler;
  requireScope(scope: ApiKeyScope): preHandlerHookHandler;
  requireRole(role: Exclude<AccountRole, "submitter">): preHandlerHookHandler;
}

/** The bearer value, or undefined. A malformed `Authorization` header is treated as absent. */
export function bearerOf(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (typeof header !== "string") return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim();
  return token === "" ? undefined : token;
}

/**
 * The principal a gate resolved. Throws rather than returning undefined: reaching a handler that
 * calls this without its gate in front of it is a wiring bug, not a request-time condition.
 */
export function principalOf(request: FastifyRequest): RequestPrincipal {
  const principal = request.principal;
  if (!principal) throw new Error("route handler read request.principal without an auth gate");
  return principal;
}

function send(reply: FastifyReply, status: number, error: string, message: string): void {
  void reply.code(status).send({ error, message });
}

/**
 * What resolving this request's credential concluded — computed once, then reused.
 *
 * The two failing arms carry the answer a gate WOULD have sent rather than the error itself,
 * because the refusal has to survive the resolver returning quietly: the gate that runs later must
 * reproduce exactly the status, code and message the un-split `resolve()` produced, without
 * verifying the credential a second time. They are SEPARATE arms because only one of them may be
 * counted — see the header.
 */
export type PrincipalResolution =
  | { kind: "anonymous" }
  | { kind: "principal" }
  /** The credential was PRESENTED AND REFUSED — a 4xx. Meterable: the caller caused it. */
  | { kind: "refused"; status: number; code: string; message: string }
  /** The credential could not be CHECKED — a 5xx. Never metered: we caused it. */
  | { kind: "unavailable"; status: number; code: string; message: string };

export function registerAuth(app: FastifyInstance, options: AuthOptions = {}): AuthDecorators {
  const db = options.db ?? defaultDb;
  const auth = options.auth ?? defaultAuth();
  const sessions = new SessionService(auth);
  const accounts = new AccountService(db, app.log);
  const principals = new PrincipalService(db, {
    accounts,
    keys: new ApiKeyService(db),
    sessions,
  });

  // Declared so `request.principal` exists on every request object rather than being added as a
  // property later, which would deoptimise the shared shape Fastify allocates per request.
  app.decorateRequest("principal", null);
  // The cache slot for the resolution above. Declared for the same reason, and so a chain of
  // [resolvePrincipal, limiter, gate] costs ONE credential verification rather than two.
  app.decorateRequest("principalResolution", null);

  /** Verify the credential. Populates `request.principal`; answers nothing, throws nothing. */
  async function computeResolution(request: FastifyRequest): Promise<PrincipalResolution> {
    const token = bearerOf(request);
    if (token === undefined) return { kind: "anonymous" };
    try {
      request.principal = await principals.fromBearer(token);
      return { kind: "principal" };
    } catch (error) {
      if (isHttpError(error)) {
        // The 4xx/5xx split is the whole decision: a refusal is the caller's, an outage is ours.
        const kind = error.status >= 500 ? "unavailable" : "refused";
        return { kind, status: error.status, code: error.code, message: error.message };
      }
      request.log.error(error);
      return {
        kind: "unavailable",
        status: 500,
        code: "internal_error",
        message: "internal server error",
      };
    }
  }

  /** The cached form. Every gate and the quiet resolver go through this one. */
  async function resolveOnce(request: FastifyRequest): Promise<PrincipalResolution> {
    const cached = request.principalResolution;
    if (cached) return cached;
    const outcome = await computeResolution(request);
    request.principalResolution = outcome;
    return outcome;
  }

  /** Resolve, or answer. Returns true when the request may continue. */
  async function resolve(
    request: FastifyRequest,
    reply: FastifyReply,
    required: boolean,
  ): Promise<boolean> {
    const outcome = await resolveOnce(request);
    if (outcome.kind === "refused" || outcome.kind === "unavailable") {
      send(reply, outcome.status, outcome.code, outcome.message);
      return false;
    }
    if (outcome.kind === "anonymous" && required) {
      send(
        reply,
        401,
        "unauthorized",
        "this endpoint requires an `Authorization: Bearer` credential.",
      );
      return false;
    }
    return true;
  }

  const resolvePrincipal: onRequestAsyncHookHandler = async (request) => {
    await resolveOnce(request);
  };

  const requireAuth: preHandlerHookHandler = async (request, reply) => {
    await resolve(request, reply, true);
  };

  const optionalAuth: preHandlerHookHandler = async (request, reply) => {
    await resolve(request, reply, false);
  };

  const requireSession: preHandlerHookHandler = async (request, reply) => {
    if (!(await resolve(request, reply, true))) return;
    if (request.principal?.credentialKind !== "session") {
      send(
        reply,
        403,
        "session_required",
        "this endpoint accepts a signed-in session only. An API key cannot manage credentials, change account identity, review or administer.",
      );
    }
  };

  const requireScope = (scope: ApiKeyScope): preHandlerHookHandler => {
    return async (request, reply) => {
      if (!(await resolve(request, reply, true))) return;
      const principal = request.principal;
      if (!principal) return;
      // A session is the account acting directly, not a scoped delegation of it, so scopes do not
      // apply to one.
      if (principal.credentialKind === "session") return;
      if (!principal.scopes.includes(scope)) {
        send(reply, 403, "missing_scope", `this endpoint requires the \`${scope}\` scope.`);
      }
    };
  };

  const requireRole = (role: Exclude<AccountRole, "submitter">): preHandlerHookHandler => {
    return async (request, reply) => {
      if (!(await resolve(request, reply, true))) return;
      const principal = request.principal;
      if (!principal) return;
      if (principal.credentialKind !== "session") {
        send(
          reply,
          403,
          "session_required",
          "review and administration accept a signed-in session only; a global role never elevates an API key.",
        );
        return;
      }
      const permitted = role === "admin" ? ["admin"] : ["reviewer", "admin"];
      if (!permitted.includes(principal.role)) {
        send(reply, 403, "forbidden", `this endpoint requires the \`${role}\` role.`);
      }
    };
  };

  const decorators: AuthDecorators = {
    auth,
    principals,
    resolvePrincipal,
    requireAuth,
    requireSession,
    optionalAuth,
    requireScope,
    requireRole,
  };
  app.decorate("auth", decorators);
  return decorators;
}
