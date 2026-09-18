import type { FastifyReply, FastifyRequest } from "fastify";
import { EmailPreferenceService } from "../../services/notifications/email-preference.service.js";
import { handled, queryOf } from "../../shared/route-helpers.js";

const preferences = new EmailPreferenceService();

const INVALID =
  "This unsubscribe link is not valid. Use the link in your most recent reminder email.";

function page(reply: FastifyReply, status: number, body: string): FastifyReply {
  return reply
    .code(status)
    .type("text/html; charset=utf-8")
    .header("cache-control", "no-store")
    .header("referrer-policy", "no-referrer")
    .header(
      "content-security-policy",
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    )
    .send(`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>RFP Hub email preferences</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem}button{font:inherit;padding:.5rem 1rem}</style>
</head>
<body>${body}</body>
</html>`);
}

export const emailController = {
  // A GET never changes anything: mail scanners prefetch links.
  confirm: handled(async (request: FastifyRequest, reply: FastifyReply) => {
    const { token } = queryOf<{ token: string }>(request);
    if (!preferences.isValidStaleReminderToken(token)) return page(reply, 400, `<p>${INVALID}</p>`);
    return page(
      reply,
      200,
      `<h1>Stop stale listing reminders?</h1>
<p>RFP Hub emails publishers when their listings have not been updated for a while. Confirm to stop these reminders for your account. Sign-in and account emails are not affected.</p>
<form method="post"><input type="hidden" name="List-Unsubscribe" value="One-Click"><button type="submit">Stop reminders</button></form>`,
    );
  }),

  unsubscribe: handled(async (request: FastifyRequest, reply: FastifyReply) => {
    const { token } = queryOf<{ token: string }>(request);
    if (!(await preferences.optOutOfStaleReminders(token))) {
      return page(reply, 400, `<p>${INVALID}</p>`);
    }
    return page(
      reply,
      200,
      "<h1>Reminders stopped</h1><p>You will no longer receive stale listing reminders from RFP Hub.</p>",
    );
  }),
};
