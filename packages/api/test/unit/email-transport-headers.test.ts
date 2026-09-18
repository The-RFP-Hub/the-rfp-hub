/** Every transport that sends must carry `OutboundEmail.headers` to its provider. */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EmailConfig } from "../../src/config.js";
import {
  createEmailTransport,
  outboxFileFor,
} from "../../src/modules/services/email/email-transport.js";

const sesSends = vi.hoisted(() => [] as unknown[]);
vi.mock("@aws-sdk/client-sesv2", () => ({
  SESv2Client: class {
    async send(command: { input: unknown }) {
      sesSends.push(command.input);
      return {};
    }
  },
  SendEmailCommand: class {
    constructor(readonly input: unknown) {}
  },
}));

const HEADERS = {
  "List-Unsubscribe": "<https://api.example.org/v1/email/unsubscribe?token=1.x>",
  "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
};
const MESSAGE = {
  to: "person@example.org",
  subject: "Please review stale listings",
  text: "body",
  headers: HEADERS,
};

function cfg(overrides: Partial<EmailConfig>): EmailConfig {
  return {
    transport: "memory",
    from: "no-reply@rfphub.invalid",
    outboxDir: undefined,
    sesRegion: "us-east-1",
    resendApiKey: "resend-test-credential",
    mailgunApiKey: "mailgun-test-credential",
    mailgunDomain: "mg.rfphub.invalid",
    mailgunApiBase: "https://api.mailgun.net",
    ...overrides,
  };
}

function captureFetch(): Array<RequestInit | undefined> {
  const seen: Array<RequestInit | undefined> = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
    seen.push(init);
    return new Response("{}", { status: 200 });
  });
  return seen;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("email transports carry custom headers", () => {
  it("ses", async () => {
    await createEmailTransport(cfg({ transport: "ses" })).send(MESSAGE);
    expect(sesSends[0]).toMatchObject({
      Content: {
        Simple: {
          Headers: [
            { Name: "List-Unsubscribe", Value: HEADERS["List-Unsubscribe"] },
            { Name: "List-Unsubscribe-Post", Value: HEADERS["List-Unsubscribe-Post"] },
          ],
        },
      },
    });
  });

  it("resend", async () => {
    const seen = captureFetch();
    await createEmailTransport(cfg({ transport: "resend" })).send(MESSAGE);
    expect(JSON.parse(String(seen[0]?.body)).headers).toEqual(HEADERS);
  });

  it("mailgun", async () => {
    const seen = captureFetch();
    await createEmailTransport(cfg({ transport: "mailgun" })).send(MESSAGE);
    const form = seen[0]?.body as FormData;
    expect(form.get("h:List-Unsubscribe")).toBe(HEADERS["List-Unsubscribe"]);
    expect(form.get("h:List-Unsubscribe-Post")).toBe(HEADERS["List-Unsubscribe-Post"]);
  });

  it("file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "rfphub-outbox-"));
    try {
      await createEmailTransport(cfg({ transport: "file", outboxDir: dir })).send(MESSAGE);
      const line = await readFile(outboxFileFor(dir, MESSAGE.to), "utf8");
      expect(JSON.parse(line).headers).toEqual(HEADERS);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("memory", async () => {
    const transport = createEmailTransport(cfg({ transport: "memory" }));
    await transport.send(MESSAGE);
    expect(transport.drain?.(MESSAGE.to)[0]?.headers).toEqual(HEADERS);
  });

  it("stdout", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await createEmailTransport(cfg({ transport: "stdout" })).send(MESSAGE);
    expect(String(log.mock.calls[0]?.[0])).toContain(
      `List-Unsubscribe-Post: ${HEADERS["List-Unsubscribe-Post"]}`,
    );
  });
});
