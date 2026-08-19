/**
 * How a one-time code reaches a person — the one seam between "the API decided to send a code" and
 * a third party.
 *
 * It is an interface with six implementations rather than a call to an SDK because the same code
 * path has to serve four situations that have nothing in common: a deployment that must really send
 * mail, an E2E run that must read the code back from another process, an integration test that must
 * read it back in-process, and a developer who just wants to see it. Every one of those is a
 * different answer to "where did the message go", and none of them should be a branch inside the
 * auth instance.
 *
 * THE PRODUCTION SAFETY IS IN `config.ts`, NOT HERE. `readEmailTransport` refuses to boot under
 * `NODE_ENV=production` on any transport that does not actually deliver (`file`, `stdout`,
 * `memory`, `null`), in the shape `readAllowPrivateHosts` uses. A deployment whose codes go to a
 * file nobody reads is not degraded, it is a locked door — and it would present as "the code never
 * arrived", for every user at once, with nothing in the logs. The check is repeated here as a
 * defence in depth, because this factory is also reachable from a test that builds a config by hand.
 *
 * NOTHING HERE LOGS A CODE except the transports whose entire purpose is to reveal it. `ses` and
 * `resend` never write the body anywhere.
 */
import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { EmailConfig, EmailTransportKind } from "../config.js";

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
  return cfg.transport !== "null";
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
      });
      // The body may name the address; the status alone says what an operator needs to know.
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
