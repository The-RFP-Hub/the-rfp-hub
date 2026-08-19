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
 */
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
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

export function registerAuth(app: FastifyInstance, options: AuthOptions = {}): AuthDecorators {
  const db = options.db ?? defaultDb;
  const auth = options.auth ?? defaultAuth();
  const sessions = new SessionService(auth);
  const accounts = new AccountService(db);
  const principals = new PrincipalService(db, {
    accounts,
    keys: new ApiKeyService(db),
    sessions,
  });

  // Declared so `request.principal` exists on every request object rather than being added as a
  // property later, which would deoptimise the shared shape Fastify allocates per request.
  app.decorateRequest("principal", null);

  /** Resolve, or answer. Returns true when the request may continue. */
  async function resolve(
    request: FastifyRequest,
    reply: FastifyReply,
    required: boolean,
  ): Promise<boolean> {
    const token = bearerOf(request);
    if (token === undefined) {
      if (!required) return true;
      send(
        reply,
        401,
        "unauthorized",
        "this endpoint requires an `Authorization: Bearer` credential.",
      );
      return false;
    }
    try {
      request.principal = await principals.fromBearer(token);
      return true;
    } catch (error) {
      if (isHttpError(error)) {
        send(reply, error.status, error.code, error.message);
        return false;
      }
      request.log.error(error);
      send(reply, 500, "internal_error", "internal server error");
      return false;
    }
  }

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
    requireAuth,
    requireSession,
    optionalAuth,
    requireScope,
    requireRole,
  };
  app.decorate("auth", decorators);
  return decorators;
}
