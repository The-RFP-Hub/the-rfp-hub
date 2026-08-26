/** The central service owns transport selection and maps expected delivery failures to values. */
import { describe, expect, it } from "vitest";
import type { EmailConfig } from "../../src/config.js";
import {
  type EmailTransport,
  createEmailTransport,
} from "../../src/modules/services/email/email-transport.js";
import { EmailService } from "../../src/modules/services/email/email.service.js";

const config: EmailConfig = {
  transport: "memory",
  from: "no-reply@rfphub.invalid",
  outboxDir: undefined,
  sesRegion: undefined,
  resendApiKey: undefined,
  mailgunApiKey: undefined,
  mailgunDomain: undefined,
  mailgunApiBase: "https://api.mailgun.net",
};

const message = {
  to: "publisher@rfphub.invalid",
  subject: "A possible duplicate needs attention",
  text: "A listing looked similar to another submission.",
};

describe("central email service", () => {
  it("selects the configured memory transport and sends text-only messages through it", async () => {
    const transport = createEmailTransport(config);
    const selected: Array<{ config: EmailConfig; production: boolean }> = [];
    const email = new EmailService({
      config,
      production: false,
      transportFactory(seenConfig, production) {
        selected.push({ config: seenConfig, production });
        return transport;
      },
    });

    await expect(email.send(message)).resolves.toEqual({ status: "sent" });
    expect(selected).toEqual([{ config, production: false }]);
    expect(transport.drain?.(message.to)).toEqual([message]);
  });

  it("maps an expected transport rejection without throwing", async () => {
    const transport: EmailTransport = {
      kind: "memory",
      async send() {
        throw new Error("test transport refused the message");
      },
    };
    const email = new EmailService({ config, transport });

    await expect(email.send(message)).resolves.toEqual({
      status: "failed",
      error: "transport_failure",
      reason: "test transport refused the message",
    });
  });
});
