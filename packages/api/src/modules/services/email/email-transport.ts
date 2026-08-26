/**
 * How an outbound email reaches a person — the low-level seam between the central email service
 * and a third party.
 *
 * It is an interface with seven implementations rather than a call to an SDK because the same code
 * path has to serve four situations that have nothing in common: a deployment that must really send
 * mail, an E2E run that must read the code back from another process, an integration test that must
 * read it back in-process, and a developer who just wants to see it. Every one of those is a
 * different answer to "where did the message go", and none of them should be a branch inside a
 * domain composer or auth adapter.
 *
 * THE PRODUCTION SAFETY IS IN `config.ts`, NOT HERE. `readEmailTransport` refuses to boot under
 * `NODE_ENV=production` on any transport that does not actually deliver (`file`, `stdout`,
 * `memory`, `null`), in the shape `readAllowPrivateHosts` uses. A deployment whose codes go to a
 * file nobody reads is not degraded, it is a locked door — and it would present as "the code never
 * arrived", for every user at once, with nothing in the logs. The check is repeated here as a
 * defence in depth, because this factory is also reachable from a test that builds a config by hand.
 *
 * NOTHING HERE LOGS A CODE except the transports whose entire purpose is to reveal it. `ses`,
 * `resend` and `mailgun` never write the body anywhere.
 */
import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { EmailConfig, EmailTransportKind } from "../../../config.js";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface EmailTransport {
  /**
   * What this transport IS, so a caller can ask rather than infer. The one question anybody asks of
   * it — "does this deliver anywhere?" — is answered by `deliversEmail`, not by comparing strings at
   * the call site.
   */
  readonly kind: EmailTransportKind;
  send(message: EmailMessage): Promise<void>;
  /**
   * Test seam, present only on `memory`. Returns and REMOVES the messages queued for an address —
   * removal because a consumed code must not be readable by a later assertion that did not send it.
   */
  drain?(to: string): EmailMessage[];
}

/**
 * Whether a configuration delivers a message ANYWHERE a person could read it.
 *
 * Only `null` does not. `file`, `stdout` and `memory` all deliver somewhere — a developer's
 * terminal, an E2E run's outbox, a test's array — which is exactly why they are usable seams and
 * why they are refused in production rather than merely discouraged.
 *
 * The question lives here, with the transports, so the HTTP layer can ASK it instead of comparing
 * configuration strings and drifting the moment a transport is added.
 */
export function deliversEmail(cfg: EmailConfig): boolean {
  if (cfg.transport === "null") return false;
  // A mailgun transport without its credential pair EXISTS but cannot authenticate. Answering
  // "does not deliver" here is what turns a half-configured deployment into a degraded one
  // instead of a broken one: the sender routes read this predicate and refuse with an explicit
  // 503, everything that sends nothing keeps serving, and the moment both keys reach the
  // environment the same build answers true and delivery is live — no code change, no redeploy.
  if (cfg.transport === "mailgun") {
    return cfg.mailgunApiKey !== undefined && cfg.mailgunDomain !== undefined;
  }
  return true;
}

/** The transports that reveal the code instead of delivering it. Refused in production. */
const LOCAL_ONLY: ReadonlySet<EmailConfig["transport"]> = new Set([
  "file",
  "stdout",
  "memory",
  "null",
]);

/**
 * One file per address, named by a digest rather than the address itself.
 *
 * The directory is world-unreadable and so are the files, but the FILE NAMES are the part that
 * survives a screenshot, a `ls` in a CI log or a stray tarball — and a directory listing that spells
 * out every address that has ever signed in is a disclosure on its own. The digest keeps the
 * one-file-per-address property (no interleaving, no cross-identity race) without publishing the
 * addresses.
 */
export function outboxFileFor(dir: string, to: string): string {
  return path.join(dir, `${recipientDigest(to)}.jsonl`);
}

function recipientDigest(to: string): string {
  return createHash("sha256").update(to.trim().toLowerCase()).digest("hex");
}

/**
 * A recipient, as something a log may carry.
 *
 * An address in a log line is PII that outlives the incident it was written for, and a delivery
 * failure needs to be CORRELATABLE, not identifiable: twelve hex characters are enough to tell
 * "the same address keeps failing" from "every address is failing", which is the only question a
 * delivery log has to answer. The full digest is what the file transport names its outbox by, so
 * an operator debugging locally can join the two.
 */
export function recipientFingerprint(to: string): string {
  return recipientDigest(to).slice(0, 12);
}

function fileTransport(dir: string): EmailTransport {
  return {
    kind: "file",
    async send(message) {
      // 0700/0600: the outbox holds live sign-in codes. On a shared machine the default umask would
      // make them readable by every other account on it.
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const line = `${JSON.stringify({ ...message, at: new Date().toISOString() })}\n`;
      await appendFile(outboxFileFor(dir, message.to), line, { mode: 0o600 });
    },
  };
}

function memoryTransport(): EmailTransport {
  const queued = new Map<string, EmailMessage[]>();
  return {
    kind: "memory",
    async send(message) {
      const key = message.to.toLowerCase();
      queued.set(key, [...(queued.get(key) ?? []), message]);
    },
    drain(to) {
      const key = to.toLowerCase();
      const messages = queued.get(key) ?? [];
      queued.delete(key);
      return messages;
    },
  };
}

/**
 * How long ONE provider call may take before it is abandoned.
 *
 * Not a nicety: `notification-dispatch` leases a row for a five-minute retry floor and renews that
 * lease immediately before each send, so a single call that outlives the floor is the one thing
 * that can put a row back in play while it is still being sent. Neither the AWS SDK nor `fetch`
 * imposes any deadline of its own — a silent socket hangs until the OS gives up, which is measured
 * in minutes. Thirty seconds is far longer than any healthy send and comfortably inside the floor,
 * and it is deliberately not configurable: it is a correctness bound of the dispatcher, not an
 * operator preference. (`mailgun` already carries a tighter one for the sign-in path.)
 */
const SEND_TIMEOUT_MS = 30_000;

/**
 * Amazon SES through the task role — the reason SES was chosen over an API-key provider.
 *
 * The SDK is imported lazily, inside `send`, so a deployment that uses any other transport never
 * loads it and a test run never pays for resolving it. It is an optional dependency in exactly the
 * sense that matters: absent, this transport throws the moment it is used rather than at import.
 */
function sesTransport(cfg: EmailConfig): EmailTransport {
  // WHAT SES GENUINELY REQUIRES OF US, and only that. The envelope sender is ours and the API
  // refuses a message without one, so it is checked here. The REGION deliberately is not: the SDK
  // resolves it from its own chain (this config already merges AWS_SES_REGION and AWS_REGION, and a
  // task can also carry it in the container's metadata), so demanding it here would invent a
  // constraint and refuse to boot deployments that are correctly configured.
  //
  // There is no credential to check — the task role carries it, which is why SES was chosen.
  requireSender(cfg, "ses");
  return {
    kind: "ses",
    async send(message) {
      const { SESv2Client, SendEmailCommand } = await import("@aws-sdk/client-sesv2");
      const client = new SESv2Client(cfg.sesRegion ? { region: cfg.sesRegion } : {});
      await client.send(
        new SendEmailCommand({
          FromEmailAddress: cfg.from,
          Destination: { ToAddresses: [message.to] },
          Content: {
            Simple: {
              Subject: { Data: message.subject, Charset: "UTF-8" },
              Body: { Text: { Data: message.text, Charset: "UTF-8" } },
            },
          },
        }),
        // The SDK's own retry policy is per-attempt; this bounds the whole call. See
        // `SEND_TIMEOUT_MS` — a send that outlives the dispatch lease is the hazard being closed.
        { abortSignal: AbortSignal.timeout(SEND_TIMEOUT_MS) },
      );
    },
  };
}

/** Kept as an interface-level alternative to SES. No deployment uses it; it needs an API key. */
function resendTransport(cfg: EmailConfig): EmailTransport {
  // Checked HERE, not inside `send`. A credential this transport cannot work without is a boot-time
  // fact, and discovering it at send time means discovering it in a detached promise nobody is
  // waiting on: the request has already answered 200, and the deployment delivers nothing to anyone
  // until somebody reads the log. Same precedent as refusing a non-delivering transport in
  // production — the failure belongs at the moment the configuration is wrong.
  const apiKey = cfg.resendApiKey;
  if (apiKey === undefined) {
    throw new Error(
      "EMAIL_TRANSPORT=resend requires RESEND_API_KEY. Without it no sign-in code can be delivered and every sign-in would stall at the code prompt.",
    );
  }
  return {
    kind: "resend",
    async send(message) {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          from: cfg.from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
        }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      // The body may name the address; the status alone says what an operator needs to know.
      if (!response.ok)
        throw new Error(`the email provider refused the message (${response.status})`);
    },
  };
}

/**
 * A single send may hang for this long before it is abandoned.
 *
 * The send is NOT awaited by the request that triggered it (see `better-auth.ts`), so a hung
 * connection costs nobody a response — what it costs is a socket and a pending promise, per
 * sign-in attempt, for as long as the provider stays silent. Ten seconds is the same order as the
 * verifier's own fetch bound, and well inside the five-minute life of the code being carried: a
 * send that has not completed by then has missed the only window it mattered in.
 */
const MAILGUN_TIMEOUT_MS = 10_000;

/**
 * Mailgun's messages API — for a deployment that already operates Mailgun and does not have a task
 * role to lend SES.
 *
 * ONE HTTPS CALL, so it is written as one: HTTP Basic with the literal user `api`, the key as the
 * password, and a `multipart/form-data` body. An SDK here would be a dependency, a transitive tree
 * and a release cadence in exchange for `fetch` plus `FormData`, on the one path that must keep
 * working for anybody to sign in at all.
 *
 * MULTIPART IS THE DOCUMENTED ENCODING, and it is the only one the provider's reference for this
 * endpoint promises — url-encoded may well be accepted today, but it is undocumented behaviour, and
 * this send happens inside a detached promise whose only failure signal is a log line. An encoding
 * that stops working here presents as "the code never arrived", so it is not a place to rely on
 * something unpromised. The CONTENT-TYPE IS DELIBERATELY NOT SET HERE: `fetch` derives it from the
 * `FormData` together with the boundary that makes the body parseable, and a hand-written
 * `multipart/form-data` header without that boundary is the classic way this breaks.
 *
 * The SENDING DOMAIN IS PART OF THE URL, not part of the message: it is the domain whose DKIM keys
 * Mailgun holds, and it is routinely a subdomain of `EMAIL_FROM`'s domain rather than the same
 * string. Both are needed and neither substitutes for the other.
 */
function mailgunTransport(cfg: EmailConfig): EmailTransport {
  // A missing half of the credential pair is DEGRADED, NOT FATAL. Refusing to construct here
  // used to couple the whole service's boot to a mail key — a half-configured secret crash-looped
  // a deployment whose public surface needed no email at all. The wired path never reaches this
  // transport's send while the pair is incomplete (`deliversEmail` answers false and the sender
  // routes 503 first, loudly), so the throw below is defence in depth for a hand-built config
  // that skipped the predicate — it rejects the send, it never takes down a boot.
  const apiKey = cfg.mailgunApiKey;
  const domain = cfg.mailgunDomain;
  if (apiKey === undefined || domain === undefined) {
    return {
      kind: "mailgun",
      async send() {
        throw new Error(
          "mailgun transport has no MAILGUN_API_KEY/MAILGUN_DOMAIN — delivery is disabled and this send should have been unreachable (deliversEmail gates the sender routes).",
        );
      },
    };
  }
  // Built once, not per message: it is a constant of the configuration, and re-deriving it on every
  // send would put the key through a base64 encode on the login path for nothing.
  const authorization = `Basic ${Buffer.from(`api:${apiKey}`).toString("base64")}`;
  // Encoded, though a sending domain is a hostname and needs no encoding: this value comes from the
  // environment and lands in a URL path, so it is escaped rather than trusted to be well-behaved.
  const endpoint = `${cfg.mailgunApiBase}/v3/${encodeURIComponent(domain)}/messages`;
  return {
    kind: "mailgun",
    async send(message) {
      // The same four fields SES and Resend are given. There is no `html` part anywhere in this
      // file: a text-only body is one fewer thing a mail client can render into something the
      // recipient did not expect.
      const form = new FormData();
      form.set("from", cfg.from);
      form.set("to", message.to);
      form.set("subject", message.subject);
      form.set("text", message.text);
      const response = await fetch(endpoint, {
        method: "POST",
        // `authorization` and nothing else — see the note above on who owns `content-type`.
        headers: { authorization },
        body: form,
        signal: AbortSignal.timeout(MAILGUN_TIMEOUT_MS),
      });
      // The body echoes the recipient and the status alone says what an operator needs to know —
      // same line as `resend`, deliberately, because it is the same fact. A rejection from `fetch`
      // (DNS, TLS, the timeout above) is left to propagate as itself.
      if (!response.ok)
        throw new Error(`the email provider refused the message (${response.status})`);
    },
  };
}

/** Every transport that really sends needs somebody to send AS. */
function requireSender(cfg: EmailConfig, kind: EmailTransportKind): void {
  if (cfg.from.trim() === "") {
    throw new Error(
      `EMAIL_TRANSPORT=${kind} requires EMAIL_FROM — a message needs an envelope sender.`,
    );
  }
}

export function createEmailTransport(cfg: EmailConfig, production = false): EmailTransport {
  if (production && LOCAL_ONLY.has(cfg.transport)) {
    throw new Error(
      `EMAIL_TRANSPORT=${cfg.transport} cannot be used under NODE_ENV=production: nothing would be delivered and every sign-in would stall at the code prompt.`,
    );
  }
  switch (cfg.transport) {
    case "ses":
      return sesTransport(cfg);
    case "resend":
      requireSender(cfg, "resend");
      return resendTransport(cfg);
    case "mailgun":
      requireSender(cfg, "mailgun");
      return mailgunTransport(cfg);
    case "file": {
      if (cfg.outboxDir === undefined) {
        throw new Error("EMAIL_TRANSPORT=file requires EMAIL_OUTBOX_DIR.");
      }
      return fileTransport(cfg.outboxDir);
    }
    case "memory":
      return memoryTransport();
    case "stdout":
      return {
        kind: "stdout",
        async send(message) {
          // The whole point of this transport, and the reason it cannot be a deployment's.
          console.log(`[email:${message.to}] ${message.subject}\n${message.text}`);
        },
      };
    case "null":
      return {
        kind: "null",
        async send() {
          /* Deliberately nothing: the "email is not configured" state, made explicit. */
        },
      };
  }
}
