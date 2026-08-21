/**
 * The `mailgun` transport, and the two properties that are not about Mailgun at all: that a
 * transport which cannot authenticate refuses when it is BUILT rather than when a code is due, and
 * that nothing on this path writes a recipient or a credential anywhere a log could keep it.
 *
 * Driven through a stubbed `globalThis.fetch` because the whole implementation IS one fetch: there
 * is no client object to inject and no seam worth inventing for one call. What the assertions
 * therefore have to check is the request itself — the URL the sending domain lands in, the Basic
 * credential, and the four form fields — since a wrong one of those is a 401 or a silently
 * undelivered message in a deployment and nothing at all in a type checker.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createEmailTransport,
  deliversEmail,
  recipientFingerprint,
} from "../../src/auth/email-transport.js";
import type { EmailConfig } from "../../src/config.js";

/**
 * DELIBERATELY NOT SHAPED LIKE A REAL KEY. A Mailgun key is `key-` and 32 hex characters, which is
 * a published detector pattern — a fixture in that shape is refused by push protection and, worse,
 * teaches the next reader that a plausible-looking credential in a test file is fine. Nothing here
 * depends on the shape: what is asserted is where the value lands, not what it is.
 */
const API_KEY = "mailgun-test-credential";

function mailgunConfig(overrides: Partial<EmailConfig> = {}): EmailConfig {
  return {
    transport: "mailgun",
    from: "no-reply@rfphub.invalid",
    outboxDir: undefined,
    sesRegion: undefined,
    resendApiKey: undefined,
    mailgunApiKey: API_KEY,
    mailgunDomain: "mg.rfphub.invalid",
    mailgunApiBase: "https://api.mailgun.net",
    ...overrides,
  };
}

const MESSAGE = {
  to: "person@example.org",
  subject: "Your RFP Hub sign-in code",
  text: "Your RFP Hub code is 123456. It expires in 5 minutes.",
};

interface SeenRequest {
  url: string;
  method: string | undefined;
  /** Only what the transport set by hand. `content-type` must NOT be among them; see below. */
  headers: Record<string, string>;
  /**
   * The parts, read off the `FormData` the transport passed — NOT off a serialised body. Nothing
   * here reconstructs the multipart encoding, because nothing in the transport writes it: `fetch`
   * does, with the boundary, which is the whole reason the header is left to it.
   */
  fields: FormData;
  signal: AbortSignal | null | undefined;
}

/** Records what the transport asked for, and answers with whatever the case under test needs. */
function stubFetch(reply: Response | Error): SeenRequest[] {
  const seen: SeenRequest[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const headers = new Headers(init?.headers);
    seen.push({
      url: String(input),
      method: init?.method,
      headers: Object.fromEntries(headers.entries()),
      fields: init?.body instanceof FormData ? init.body : new FormData(),
      signal: init?.signal,
    });
    if (reply instanceof Error) throw reply;
    return reply;
  });
  return seen;
}

/** Every part, flattened, for the assertions that are about what must NOT be in the body. */
function partsOf(request: SeenRequest | undefined): string {
  return [...(request?.fields.entries() ?? [])]
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("mailgun transport", () => {
  it("posts the message to the sending domain's messages endpoint", async () => {
    const seen = stubFetch(new Response("{}", { status: 200 }));
    await createEmailTransport(mailgunConfig()).send(MESSAGE);

    expect(seen).toHaveLength(1);
    const request = seen[0];
    expect(request?.url).toBe("https://api.mailgun.net/v3/mg.rfphub.invalid/messages");
    expect(request?.method).toBe("POST");
    // Abandoned rather than left hanging: the send is not awaited by any request, so a silent
    // provider would otherwise hold a socket per sign-in attempt for as long as it stayed silent.
    expect(request?.signal).toBeInstanceOf(AbortSignal);
  });

  // FETCH OWNS THE CONTENT-TYPE, because only fetch knows the boundary it generated for the
  // multipart body. A hand-set `multipart/form-data` header would arrive without that boundary and
  // the provider would have no way to parse a single part — a failure that shows up nowhere but a
  // detached promise's log line.
  it("sets the authorization header and leaves content-type to fetch", async () => {
    const seen = stubFetch(new Response("{}", { status: 200 }));
    await createEmailTransport(mailgunConfig()).send(MESSAGE);

    expect(Object.keys(seen[0]?.headers ?? {})).toEqual(["authorization"]);
    expect(seen[0]?.headers["content-type"]).toBeUndefined();
    // …and the body really is the multipart the documented endpoint takes, not a url-encoded one.
    expect(seen[0]?.fields).toBeInstanceOf(FormData);
  });

  // The one detail that is wrong in exactly one way and cannot be caught anywhere else: Mailgun's
  // Basic user is the literal string `api`, not the key, not the domain, and not the sender.
  it("authenticates as the literal user `api` with the key as the password", async () => {
    const seen = stubFetch(new Response("{}", { status: 200 }));
    await createEmailTransport(mailgunConfig()).send(MESSAGE);

    const authorization = seen[0]?.headers.authorization ?? "";
    expect(authorization.startsWith("Basic ")).toBe(true);
    expect(Buffer.from(authorization.slice("Basic ".length), "base64").toString()).toBe(
      `api:${API_KEY}`,
    );
  });

  it("carries the same four fields the other sending transports deliver", async () => {
    const seen = stubFetch(new Response("{}", { status: 200 }));
    await createEmailTransport(mailgunConfig()).send(MESSAGE);

    const fields = seen[0]?.fields;
    expect(fields?.get("from")).toBe("no-reply@rfphub.invalid");
    expect(fields?.get("to")).toBe(MESSAGE.to);
    expect(fields?.get("subject")).toBe(MESSAGE.subject);
    expect(fields?.get("text")).toBe(MESSAGE.text);
    // No html part anywhere in this file, so none here either.
    expect(fields?.get("html")).toBeNull();
    // The credential travels in the header and only there — a body copy would reach any middlebox
    // logging form fields, and Mailgun echoes the request in its own logs.
    expect(partsOf(seen[0])).not.toContain(API_KEY);
    expect(seen[0]?.url).not.toContain(API_KEY);
  });

  // A different region is a different HOST holding a different account, so this is not cosmetic:
  // sending an EU account's domain to the US endpoint is a 401 on every message.
  it("honours a regional base", async () => {
    const seen = stubFetch(new Response("{}", { status: 200 }));
    await createEmailTransport(
      mailgunConfig({ mailgunApiBase: "https://api.eu.mailgun.net" }),
    ).send(MESSAGE);

    expect(seen[0]?.url).toBe("https://api.eu.mailgun.net/v3/mg.rfphub.invalid/messages");
  });

  // Both failure shapes have to REJECT, because the caller's only handling of a delivery failure is
  // a `.catch` on a detached promise: a send that resolved on a 401 would log nothing, answer 200,
  // and deliver no code to anybody.
  it("rejects on a refusal, naming the status and nothing else", async () => {
    stubFetch(new Response('{"message":"person@example.org is not authorized"}', { status: 401 }));
    const error = await createEmailTransport(mailgunConfig())
      .send(MESSAGE)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("401");
    // The response body may name the recipient; the status alone is what an operator needs.
    expect(message).not.toContain(MESSAGE.to);
    expect(message).not.toContain(API_KEY);
  });

  it("rejects when the request never completes", async () => {
    stubFetch(new TypeError("fetch failed"));
    await expect(createEmailTransport(mailgunConfig()).send(MESSAGE)).rejects.toThrow(
      /fetch failed/,
    );
  });

  // Boot-time, not send-time: a credential the transport cannot work without is a fact about the
  // configuration, and discovering it inside a detached send means discovering it in a log nobody
  // reads while every request keeps answering 200.
  it("refuses to be built without the key or the domain", () => {
    expect(() => createEmailTransport(mailgunConfig({ mailgunApiKey: undefined }))).toThrow(
      /MAILGUN_API_KEY/,
    );
    expect(() => createEmailTransport(mailgunConfig({ mailgunDomain: undefined }))).toThrow(
      /MAILGUN_DOMAIN/,
    );
  });

  it("refuses to be built without an envelope sender", () => {
    expect(() => createEmailTransport(mailgunConfig({ from: "  " }))).toThrow(/EMAIL_FROM/);
  });

  // It delivers, so it is not one of the transports production refuses.
  it("is a delivering transport, usable under NODE_ENV=production", () => {
    const cfg = mailgunConfig();
    expect(deliversEmail(cfg)).toBe(true);
    expect(createEmailTransport(cfg, true).kind).toBe("mailgun");
  });
});

describe("recipientFingerprint", () => {
  // What a delivery failure is allowed to carry into a log: enough to tell "one address keeps
  // failing" from "everything is failing", and not the address.
  it("is a short digest, never the address", () => {
    const fingerprint = recipientFingerprint(MESSAGE.to);
    expect(fingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(fingerprint).not.toContain("person");
    expect(fingerprint).not.toContain("example.org");
    // Correlatable: the same address always fingerprints the same way, case and padding aside.
    expect(recipientFingerprint(" PERSON@example.org ")).toBe(fingerprint);
    expect(recipientFingerprint("someone-else@example.org")).not.toBe(fingerprint);
  });
});
