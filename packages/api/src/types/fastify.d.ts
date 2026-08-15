import type { RequestPrincipal } from "../modules/services/auth/principal.service.js";
/**
 * Type augmentation for the decorators `plugins/auth.ts` adds to the root instance.
 *
 * Declared here rather than inline so a route module can read `app.auth` and `request.principal`
 * with full types without importing the plugin, and so the shapes are stated once.
 */
import type { AuthDecorators } from "../plugins/auth.js";

declare module "fastify" {
  interface FastifyInstance {
    /** Authentication and the authorization gates. See plugins/auth.ts. */
    auth: AuthDecorators;
  }

  interface FastifyRequest {
    /**
     * Whoever this request proved to be, or null.
     *
     * Only ever populated by one of the gates in `plugins/auth.ts`; a handler that reads it without
     * a gate in front of it should use `principalOf(request)`, which says so instead of silently
     * treating an unauthenticated request as anonymous.
     */
    principal: RequestPrincipal | null;
  }
}
