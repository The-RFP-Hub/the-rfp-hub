import type { FastifyInstance, onRequestHookHandler } from "fastify";
import { RATE_LIMITED } from "../../../openapi/schemas.js";
import { UNSUBSCRIBE_TOKEN_PATTERN } from "../../services/notifications/unsubscribe-token.js";
import { meteredAuth } from "../shared/rate-limit-key.js";
import { emailController } from "./email.controller.js";

// The signed token is the credential; a Bearer header, if any, only picks the rate-limit bucket.
const signedTokenOnly: onRequestHookHandler = async () => {};

const querystring = {
  type: "object",
  required: ["token"],
  additionalProperties: false,
  properties: {
    token: {
      type: "string",
      pattern: UNSUBSCRIBE_TOKEN_PATTERN,
      description: "The signed token from a reminder email's unsubscribe link.",
    },
  },
};

const html = (description: string) => ({
  description,
  content: { "text/html": { schema: { type: "string" } } },
});

const invalid = {
  description: "A malformed token (JSON) or one this deployment did not sign (HTML).",
  content: {
    "application/json": { schema: { $ref: "ErrorResponse#" } },
    "text/html": { schema: { type: "string" } },
  },
};

export const email = async (router: FastifyInstance): Promise<void> => {
  // RFC 8058 senders use urlencoded or multipart bodies; the token in the URL is all that matters.
  router.removeAllContentTypeParsers();
  router.addContentTypeParser("*", { parseAs: "buffer", bodyLimit: 4096 }, (_r, _body, done) => {
    done(null, undefined);
  });

  router.get(
    "/unsubscribe",
    {
      schema: {
        operationId: "confirmStaleReminderUnsubscribe",
        tags: ["account"],
        summary: "Confirmation page for stopping stale listing reminders",
        description:
          "Changes nothing: link scanners prefetch email links. The page POSTs back to the same URL.",
        querystring,
        response: { 200: html("A confirmation form."), 400: invalid },
      },
    },
    emailController.confirm,
  );

  router.post(
    "/unsubscribe",
    {
      onRequest: meteredAuth(router, signedTokenOnly, { max: 120, timeWindow: "1 minute" }),
      schema: {
        operationId: "unsubscribeStaleReminders",
        tags: ["account"],
        summary: "Stop stale listing reminders (RFC 8058 one-click)",
        description:
          "Idempotent. The body (`List-Unsubscribe=One-Click`) is accepted in any encoding and ignored; the signed token names the account. Sign-in and account emails are unaffected.",
        querystring,
        response: { 200: html("Reminders are stopped."), 400: invalid, 429: RATE_LIMITED },
      },
    },
    emailController.unsubscribe,
  );
};
