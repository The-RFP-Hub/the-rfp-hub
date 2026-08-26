/**
 * One bearer token → one session, or a refusal. The `/v1` half of authentication.
 *
 * `/v1` never sees a cookie. The dashboard holds an opaque session token and sends it as
 * `Authorization: Bearer …`, which is what keeps every `/v1` route free of ambient authority — no
 * CSRF surface, no `credentials:true` CORS, no origin allowlist on the public read API. The auth
 * library's own session lookup, however, speaks cookies. This service is the two-line adapter
 * between those, and it builds the cookie header EXPLICITLY rather than leaning on the bearer
 * plugin's request hook to have injected one:
 *
 *   - the hook's ordering relative to a caller that invokes `getSession` directly is an internal
 *     detail, and one we would discover had changed by having every request 401;
 *   - the cookie's NAME is not a constant — it gains a `__Secure-` prefix under HTTPS — so it is
 *     read from the instance's own context rather than spelled here.
 *
 * `session-verify-agreement.test.ts` pins that this path and the plugin's own header path resolve
 * the same session, which is what makes the shortcut safe to keep.
 *
 * ONE FAILURE, ONE ANSWER. Expired, revoked, forged, foreign-deployment, malformed, absent — every
 * one of them returns `null` here and becomes the same 401 with the same message upstream.
 * Distinguishing them tells a prober which half of an attempt worked, and the previous verifier
 * made the same promise in the same words.
 *
 * "ONE ANSWER" IS ABOUT CREDENTIALS, NOT ABOUT THE DATABASE. A lookup that could not be performed
 * is not a credential that failed to verify, and collapsing the two is how an outage disguises
 * itself: every signed-in user is told their session is invalid, the dashboard signs them out and
 * discards a token that was in fact perfectly good, and the graph an operator sees is a 401 spike —
 * which reads as an attack, not as a database that stopped answering. So an infrastructure failure
 * is re-raised as a 503, and only a genuinely absent session is `null`.
 */
import type { Auth } from "../../../auth/better-auth.js";
import { HttpError } from "../../shared/http-error.js";

/** What a verified session tells us. The subject is the join key; the address is for `/v1/me`. */
export interface VerifiedSession {
  /** The identity's opaque user id — what `accounts.auth_user_id` stores. Never an address. */
  subject: string;
  /** The verified address, carried so `/v1/me` needs no second query. */
  email: string | null;
  /** Better-Auth's ownership verdict for the address carried by this session. */
  emailVerified: boolean;
}

export class SessionService {
  /** Resolved once: reading it builds the instance's context, which is not free per request. */
  private cookieName: Promise<string> | undefined;

  constructor(private readonly auth: Auth) {}

  /**
   * Whether a session login can be verified at all in this deployment.
   *
   * Always true, and kept as a property because the gate upstream asks the question: the previous
   * verifier could be unconfigured (no key, no app id), and a deployment with no session authority
   * had to answer 503 rather than 401. There is no such state now — the instance is constructed
   * from a secret that either exists or stopped the boot.
   */
  get configured(): boolean {
    return true;
  }

  async verify(token: string): Promise<VerifiedSession | null> {
    const value = token.trim();
    if (value === "") return null;
    try {
      const name = await this.sessionCookieName();
      const session = await this.auth.api.getSession({
        headers: new Headers({ cookie: `${name}=${encodeURIComponent(value)}` }),
      });
      const user = session?.user;
      if (!user?.id) return null;
      return {
        subject: user.id,
        email: user.email ?? null,
        emailVerified: user.emailVerified === true,
      };
    } catch (error) {
      // NOTHING ABOUT A BAD CREDENTIAL REACHES HERE, and that is checked rather than assumed:
      // `getSession` RETURNS null for every malformed, expired, revoked, foreign and unsigned token
      // (`session-verify-agreement.test.ts` drives all six), and the value is percent-encoded before
      // the header is built, so a control character cannot make the header constructor throw either.
      //
      // What is left is the lookup itself failing — the database is unreachable, the adapter threw.
      // That is a 503 with a `Retry-After`-shaped meaning, not a verdict on the caller's token.
      const failure = new HttpError(
        503,
        "auth_unavailable",
        "sessions cannot be verified right now. Try again shortly.",
      );
      // Carried for the log only: `toBody()` serialises the code, the message and `details`, so the
      // underlying driver error never reaches a response.
      failure.cause = error;
      throw failure;
    }
  }

  private async sessionCookieName(): Promise<string> {
    this.cookieName ??= this.auth.$context.then((ctx) => ctx.authCookies.sessionToken.name);
    return this.cookieName;
  }
}
