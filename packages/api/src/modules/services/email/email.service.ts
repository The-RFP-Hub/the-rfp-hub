/**
 * The application's one outbound-email seam.
 *
 * Domain code composes a subject and a text body, then hands that message to `OutboundEmailPort`.
 * Only this adapter selects and invokes a transport. That keeps provider choice, the configured
 * envelope sender, local test transports, and expected delivery failures out of auth and every
 * domain that later grows an email composer.
 */
import type { EmailConfig } from "../../../config.js";
import { config as defaultConfig } from "../../../config.js";
import {
  type EmailTransport,
  createEmailTransport,
  recipientFingerprint,
} from "./email-transport.js";

/** Text-only by design. HTML and an envelope sender are deliberately not caller-controlled. */
export interface OutboundEmail {
  to: string;
  subject: string;
  text: string;
}

export type SendResult =
  | { status: "sent" }
  | { status: "failed"; error: "transport_failure"; reason: string };

/** The narrow port domain composers and auth adapters depend on. */
export interface OutboundEmailPort {
  send(message: OutboundEmail): Promise<SendResult>;
}

export interface EmailServiceOptions {
  config?: EmailConfig;
  production?: boolean;
  /** Test seam: hold a memory transport outside the service and drain it after a send. */
  transport?: EmailTransport;
  /** Factory seam for proving configuration-driven transport selection without exposing a drain. */
  transportFactory?: (config: EmailConfig, production: boolean) => EmailTransport;
}

export class EmailService implements OutboundEmailPort {
  private readonly transport: EmailTransport;

  constructor(options: EmailServiceOptions = {}) {
    const emailConfig = options.config ?? defaultConfig.email;
    this.transport =
      options.transport ??
      (options.transportFactory ?? createEmailTransport)(
        emailConfig,
        options.production ?? process.env.NODE_ENV === "production",
      );
  }

  async send(message: OutboundEmail): Promise<SendResult> {
    try {
      await this.transport.send(message);
      return { status: "sent" };
    } catch (error) {
      return {
        status: "failed",
        error: "transport_failure",
        // Provider adapters already avoid response bodies that may echo an address. Keeping the
        // original reason here makes a job failure actionable without teaching domain code how a
        // provider reports one.
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

/** A log-safe recipient identity shared by every sender. */
export { recipientFingerprint };
