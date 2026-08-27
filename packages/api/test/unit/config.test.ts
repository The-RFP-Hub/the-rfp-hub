/**
 * PURE config tests. `src/config.ts` is where an unset or half-supplied environment turns into
 * runtime behaviour, and each reader below exists because the naive version got something wrong:
 * `Number("")` is 0 rather than NaN, an unbounded pg pool is not a neutral default on a shared
 * database instance, and a published `servers[0].url` has no safe fallback to guess at.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SIMILARITY_THRESHOLD,
  config,
  mailgunCredentialWarning,
  readAllowPrivateHosts,
  readAnalyticsHmacKey,
  readAppBaseUrl,
  readBoolean,
  readDbPoolMax,
  readEmailTransport,
  readEmbeddingProvider,
  readList,
  readMailgunApiBase,
  readNonNegativeInt,
  readPem,
  readPort,
  readPositiveInt,
  readPublicBaseUrl,
  readSimilarityThreshold,
  readTrustProxy,
} from "../../src/config.js";
import { HOST_MIN_GAP_MS } from "../../src/modules/services/verification/host-pacer.js";

describe("readPort", () => {
  it("uses the default when PORT is unset", () => {
    expect(readPort(undefined)).toBe(3001);
  });

  // The regression this exists for: `Number("")` is 0, NOT NaN, so a NaN-only guard let a
  // set-but-empty PORT — the normal shape of a templated-but-unsupplied env var — bind an
  // OS-assigned ephemeral port while every probe still pointed at 3001.
  it("falls back for a set-but-unusable value rather than binding somewhere else", () => {
    for (const raw of ["", "   ", "0", "http", "-1", "80.5", "70000", "3001abc"]) {
      expect(readPort(raw), JSON.stringify(raw)).toBe(3001);
    }
  });

  it("reads a real port, ignoring surrounding whitespace", () => {
    expect(readPort("8080")).toBe(8080);
    expect(readPort(" 8080 ")).toBe(8080);
    expect(readPort("65535")).toBe(65535);
  });

  it("honors an explicit fallback", () => {
    expect(readPort("", 4000)).toBe(4000);
  });
});

// Bounds the pg pool for a shared database instance. Same defensive shape as readPort: an
// empty/garbage/non-positive value must fall back to the default rather than disabling the bound.
describe("readDbPoolMax", () => {
  it("uses the default when DB_POOL_MAX is unset", () => {
    expect(readDbPoolMax(undefined)).toBe(10);
  });

  it("honors a set value", () => {
    expect(readDbPoolMax("5")).toBe(5);
    expect(readDbPoolMax(" 5 ")).toBe(5);
  });

  it("falls back for a set-but-unusable value", () => {
    for (const raw of ["", "   ", "0", "-1", "http", "5.5", "5abc"]) {
      expect(readDbPoolMax(raw), JSON.stringify(raw)).toBe(10);
    }
  });

  it("honors an explicit fallback", () => {
    expect(readDbPoolMax("", 3)).toBe(3);
  });
});

describe("readPublicBaseUrl", () => {
  it("defaults to the relative `/`, which is what local development runs with", () => {
    for (const raw of [undefined, "", "   "]) {
      expect(readPublicBaseUrl(raw), JSON.stringify(raw)).toBe("/");
    }
    expect(readPublicBaseUrl("/")).toBe("/");
    expect(readPublicBaseUrl(undefined, "https://api.example.org")).toBe("https://api.example.org");
  });

  it("accepts an absolute origin and normalizes it", () => {
    expect(readPublicBaseUrl("https://api.example.org")).toBe("https://api.example.org");
    expect(readPublicBaseUrl(" https://api.example.org ")).toBe("https://api.example.org");
  });

  // servers[0].url is joined with paths that already begin with "/", so a trailing slash would
  // publish "//v1/opportunities".
  it("strips a trailing slash, including under a base path", () => {
    expect(readPublicBaseUrl("https://api.example.org/")).toBe("https://api.example.org");
    expect(readPublicBaseUrl("https://proxy.example.org/api/")).toBe(
      "https://proxy.example.org/api",
    );
    expect(readPublicBaseUrl("http://localhost:3001/")).toBe("http://localhost:3001");
  });

  // The rule is about the transport, not about any particular domain: this value is published as
  // servers[0].url, so a plaintext remote origin tells EVERY client to speak plaintext. Any host
  // that is not loopback must therefore be https, whoever owns it.
  it("rejects a non-https scheme on any host that is not loopback", () => {
    for (const raw of [
      "http://example.org",
      "http://api.example.org",
      "http://api-staging.example.org",
      "http://API.EXAMPLE.ORG",
      "ftp://api.example.org",
      "http://anything-else.example.com",
      "http://192.168.1.10:3001",
      "http://10.0.0.5",
      "http://api.local",
      "http://0.0.0.0:3001",
    ]) {
      expect(() => readPublicBaseUrl(raw), raw).toThrow(/https/i);
    }
  });

  // Loopback traffic never leaves the machine, so there is no segment on which the plaintext could
  // be observed — and local development legitimately runs over plain http.
  it("accepts a plaintext scheme on a loopback host", () => {
    expect(readPublicBaseUrl("http://localhost:3001")).toBe("http://localhost:3001");
    expect(readPublicBaseUrl("http://LOCALHOST:3001")).toBe("http://localhost:3001");
    // RFC 6761 §6.3 reserves the whole *.localhost subtree to loopback.
    expect(readPublicBaseUrl("http://api.localhost:3001")).toBe("http://api.localhost:3001");
    // The whole 127.0.0.0/8 block is loopback (RFC 1122 §3.2.1.3), not just 127.0.0.1.
    expect(readPublicBaseUrl("http://127.0.0.1:3001")).toBe("http://127.0.0.1:3001");
    expect(readPublicBaseUrl("http://127.0.0.2:3001")).toBe("http://127.0.0.2:3001");
    // IPv6 loopback — new URL() reports the hostname bracketed.
    expect(readPublicBaseUrl("http://[::1]:3001")).toBe("http://[::1]:3001");
  });

  it("accepts https on any host, loopback or not", () => {
    expect(readPublicBaseUrl("https://api.example.org")).toBe("https://api.example.org");
    expect(readPublicBaseUrl("https://anything-else.example.com")).toBe(
      "https://anything-else.example.com",
    );
    expect(readPublicBaseUrl("https://localhost:3001")).toBe("https://localhost:3001");
    expect(readPublicBaseUrl("https://127.0.0.1:3001")).toBe("https://127.0.0.1:3001");
  });

  // A bare hostname is the common mistake, and there is no safe value to fall back to: serving `/`
  // in its place hands every consumer a document that resolves against whichever host loaded it.
  it("rejects a value that is not an absolute URL", () => {
    for (const raw of ["api.example.org", "https://", "//api.example.org", "not a url"]) {
      expect(() => readPublicBaseUrl(raw), raw).toThrow(/PUBLIC_BASE_URL/);
    }
  });
});

describe("readAppBaseUrl", () => {
  it("uses the local frontend in development and requires an explicit production origin", () => {
    expect(readAppBaseUrl(undefined, false)).toBe("http://localhost:3005");
    expect(() => readAppBaseUrl(undefined, true)).toThrow(/APP_BASE_URL is required/);
  });

  it("accepts and normalizes a secure frontend origin", () => {
    expect(readAppBaseUrl(" https://app.example.org/ ", true)).toBe("https://app.example.org");
    expect(readAppBaseUrl("http://127.0.0.1:3005", false)).toBe("http://127.0.0.1:3005");
  });

  it("rejects a remote plaintext URL or anything broader than an origin", () => {
    for (const raw of [
      "http://app.example.org",
      "app.example.org",
      "https://app.example.org/notifications",
      "https://app.example.org?from=email",
      "https://user@app.example.org",
    ]) {
      expect(() => readAppBaseUrl(raw, false), raw).toThrow(/APP_BASE_URL/);
    }
  });
});

// ── M3 readers ───────────────────────────────────────────────────────────────────────────────
//
// The line these draw, and it is drawn per variable: a set-but-unusable value FALLS BACK where the
// wrong value is merely wrong, and THROWS where the wrong value is dangerous. Two variables are in
// the second group and both are here — `VERIFY_ALLOW_PRIVATE_HOSTS`, which would silently disable
// the verifier's SSRF checks, and `TRUST_PROXY`, whose obvious value (`true`) hands control of
// `request.ip` to the client.

describe("readBoolean", () => {
  it("reads the usual affirmatives and negatives", () => {
    for (const raw of ["1", "true", "TRUE", " yes ", "on"]) {
      expect(readBoolean(raw, false), raw).toBe(true);
    }
    for (const raw of ["0", "false", "No", "off"]) {
      expect(readBoolean(raw, true), raw).toBe(false);
    }
  });

  // The single most common way a feature flag lies: `Boolean("false")` is true.
  it("does not treat the string 'false' as true", () => {
    expect(readBoolean("false", true)).toBe(false);
  });

  it("falls back for unset and unrecognised values", () => {
    for (const raw of [undefined, "", "  ", "maybe"]) {
      expect(readBoolean(raw, true), JSON.stringify(raw)).toBe(true);
      expect(readBoolean(raw, false), JSON.stringify(raw)).toBe(false);
    }
  });
});

describe("readPositiveInt", () => {
  it("reads a whole number and falls back for anything else", () => {
    expect(readPositiveInt("42", 7)).toBe(42);
    for (const raw of [undefined, "", "  ", "0", "-1", "1.5", "lots"]) {
      expect(readPositiveInt(raw, 7), JSON.stringify(raw)).toBe(7);
    }
  });
});

describe("readList", () => {
  it("splits, trims, drops blanks and de-duplicates while keeping order", () => {
    expect(readList(" a, b ,,a , c ")).toEqual(["a", "b", "c"]);
    expect(readList(undefined)).toEqual([]);
    expect(readList("   ")).toEqual([]);
  });
});

describe("readPem", () => {
  // A one-line secret store and a multi-line PEM only meet if the escape is restored, and the
  // failure without it is an opaque parse error that looks like a wrong key.
  it("restores newlines written as the two-character escape", () => {
    expect(readPem("-----BEGIN PUBLIC KEY-----\\nabc\\n-----END PUBLIC KEY-----")).toBe(
      "-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----",
    );
  });

  it("leaves a real multi-line value alone, and treats blank as unset", () => {
    expect(readPem("a\nb")).toBe("a\nb");
    expect(readPem("   ")).toBeUndefined();
    expect(readPem(undefined)).toBeUndefined();
  });
});

describe("readEmbeddingProvider", () => {
  it("takes an explicit provider", () => {
    expect(readEmbeddingProvider("lexical")).toBe("lexical");
    expect(readEmbeddingProvider(" Lexical ")).toBe("lexical");
    expect(readEmbeddingProvider("disabled")).toBe("disabled");
  });

  // The in-process featurizer needs no key and no network, so ABSENCE of configuration means
  // detection on — `disabled` is asked for, never inferred.
  it("defaults to lexical when nothing is configured", () => {
    expect(readEmbeddingProvider(undefined)).toBe("lexical");
    expect(readEmbeddingProvider("")).toBe("lexical");
  });

  // An ALIAS, not a distinct provider: it names the same computation family, so a deployment
  // still carrying the old value keeps detecting — for one release, after which it is rejected
  // like any other unknown value.
  it("accepts `deterministic` as a deprecated alias for lexical", () => {
    expect(readEmbeddingProvider("deterministic")).toBe("lexical");
  });

  // A deployment that asked for a hosted semantic model must not silently receive a different
  // detector — or silently detect nothing. The refusal names the one-line fix.
  it("refuses `openai` by name, pointing at the replacement", () => {
    expect(() => readEmbeddingProvider("openai")).toThrow(/lexical/);
    expect(() => readEmbeddingProvider("openai")).toThrow(/no longer supported/);
  });

  it("rejects an unknown provider rather than silently picking one", () => {
    expect(() => readEmbeddingProvider("word2vec")).toThrow(/EMBEDDING_PROVIDER/);
  });
});

describe("readSimilarityThreshold", () => {
  // A threshold is a property of an embedding space, so the default stays keyed by provider even
  // with one real provider today — the shape is where that insight is recorded, and a future
  // second space slots in without re-deriving the rule.
  it("defaults per provider", () => {
    expect(readSimilarityThreshold(undefined, "lexical")).toBe(
      DEFAULT_SIMILARITY_THRESHOLD.lexical,
    );
    expect(readSimilarityThreshold("", "disabled")).toBe(DEFAULT_SIMILARITY_THRESHOLD.disabled);
    expect(DEFAULT_SIMILARITY_THRESHOLD.lexical).not.toBe(DEFAULT_SIMILARITY_THRESHOLD.disabled);
  });

  it("takes a value in range", () => {
    expect(readSimilarityThreshold("0.9", "lexical")).toBe(0.9);
    expect(readSimilarityThreshold("0", "lexical")).toBe(0);
  });

  it("rejects a value that is not a cosine similarity", () => {
    for (const raw of ["-0.1", "1.5", "86%", "high"]) {
      expect(() => readSimilarityThreshold(raw, "lexical"), raw).toThrow(/DEDUPE_SIMILARITY/);
    }
  });
});

describe("readAllowPrivateHosts", () => {
  it("is off by default and may be enabled outside production", () => {
    expect(readAllowPrivateHosts(undefined, false)).toBe(false);
    expect(readAllowPrivateHosts("true", false)).toBe(true);
  });

  // THE GUARD. Enabling this lets the verifier reach loopback, private and link-local addresses —
  // including the instance metadata endpoint. There is no deployment in which that is right, so it
  // refuses to start rather than serving with the check off.
  it("refuses to boot under NODE_ENV=production", () => {
    expect(() => readAllowPrivateHosts("true", true)).toThrow(/VERIFY_ALLOW_PRIVATE_HOSTS/);
    expect(() => readAllowPrivateHosts("1", true)).toThrow(/production/);
    // …and is a no-op when it is not enabled.
    expect(readAllowPrivateHosts("false", true)).toBe(false);
    expect(readAllowPrivateHosts(undefined, true)).toBe(false);
  });
});

describe("readTrustProxy", () => {
  it("reads a hop count or an address list", () => {
    expect(readTrustProxy("1")).toBe(1);
    expect(readTrustProxy(" 2 ")).toBe(2);
    expect(readTrustProxy("10.0.0.0/8, 192.168.0.0/16")).toEqual(["10.0.0.0/8", "192.168.0.0/16"]);
    expect(readTrustProxy("loopback")).toEqual(["loopback"]);
  });

  it("trusts nothing when unset", () => {
    expect(readTrustProxy(undefined)).toBeUndefined();
    expect(readTrustProxy("  ")).toBeUndefined();
  });

  // The value everyone reaches for, and it means "believe whatever the client claims its address
  // is" — which turns the analytics hash into client-controlled input.
  it("rejects a boolean, and says what to write instead", () => {
    for (const raw of ["true", "TRUE", "false", "yes"]) {
      expect(() => readTrustProxy(raw), raw).toThrow(/hop count/);
    }
  });
});

describe("readEmailTransport", () => {
  it("defaults to a delivering transport in production and a visible one outside it", () => {
    expect(readEmailTransport(undefined, true)).toBe("ses");
    expect(readEmailTransport("", false)).toBe("stdout");
  });

  it("takes any known transport, case-insensitively", () => {
    expect(readEmailTransport("mailgun", true)).toBe("mailgun");
    expect(readEmailTransport(" Mailgun ", false)).toBe("mailgun");
    expect(readEmailTransport("resend", true)).toBe("resend");
    expect(readEmailTransport("memory", false)).toBe("memory");
  });

  it("rejects an unknown transport rather than silently picking one", () => {
    expect(() => readEmailTransport("smtp", false)).toThrow(/EMAIL_TRANSPORT must be one of/);
  });

  // A deployment whose codes go to a file nobody reads is a locked door, not a degraded service —
  // and the refusal has to name the transports that WOULD work, or it is a dead end.
  it("refuses a non-delivering transport in production, naming both that do deliver", () => {
    for (const raw of ["file", "stdout", "memory", "null"]) {
      expect(() => readEmailTransport(raw, true), raw).toThrow(/Use ses or mailgun/);
      expect(readEmailTransport(raw, false), raw).toBe(raw);
    }
  });
});

describe("readMailgunApiBase", () => {
  it("defaults to the US endpoint, which is where an account is unless somebody chose", () => {
    for (const raw of [undefined, "", "   "]) {
      expect(readMailgunApiBase(raw), JSON.stringify(raw)).toBe("https://api.mailgun.net");
    }
  });

  // The regional endpoints are different hosts holding different accounts: the EU one is not a
  // latency preference, it is where the account exists.
  it("takes the EU endpoint, and strips a trailing slash", () => {
    expect(readMailgunApiBase("https://api.eu.mailgun.net")).toBe("https://api.eu.mailgun.net");
    expect(readMailgunApiBase(" https://api.eu.mailgun.net/ ")).toBe("https://api.eu.mailgun.net");
  });

  // Every send carries the API key in an Authorization header, so plaintext to a remote host
  // publishes the credential — the same rule readPublicBaseUrl draws, for the same transport
  // reason, and it holds whoever owns the host.
  it("rejects plaintext on any host that is not loopback", () => {
    for (const raw of ["http://api.mailgun.net", "http://proxy.example.org"]) {
      expect(() => readMailgunApiBase(raw), raw).toThrow(/https/i);
    }
  });

  // A DIFFERENT REFUSAL, and the loopback exemption does not reach it: these are not a privacy
  // question, they are schemes `fetch` cannot send to from anywhere. Accepting one would boot a
  // deployment that looks configured until the first sign-in fails inside a detached promise.
  it("rejects a scheme no send could be made over, loopback or not", () => {
    for (const raw of [
      "ftp://localhost",
      "ws://127.0.0.1",
      "ftp://example.org",
      "wss://api.mailgun.net",
      "file:///tmp/mailgun",
    ]) {
      expect(() => readMailgunApiBase(raw), raw).toThrow(/MAILGUN_API_BASE/);
    }
  });

  // The send URL is built by concatenation, so anything that is not an origin-plus-path survives
  // that in its own wrong way — and all of these parse cleanly, so nothing above catches them: a
  // query swallows the appended path into itself, a fragment leaves the request on `/`, and
  // userinfo makes fetch throw. Every one of them boots and then delivers nothing.
  it("refuses a base carrying a query, a fragment or credentials", () => {
    for (const raw of [
      "https://api.mailgun.net?region=us",
      "https://api.mailgun.net#frag",
      "https://user:pw@api.mailgun.net",
      "https://user@api.mailgun.net",
    ]) {
      expect(() => readMailgunApiBase(raw), raw).toThrow(/MAILGUN_API_BASE/);
    }
  });

  it("accepts a plaintext loopback base, so a test double can be a local server", () => {
    expect(readMailgunApiBase("http://127.0.0.1:8025")).toBe("http://127.0.0.1:8025");
    expect(readMailgunApiBase("http://localhost:8025/")).toBe("http://localhost:8025");
    expect(readMailgunApiBase("https://api.eu.mailgun.net")).toBe("https://api.eu.mailgun.net");
    expect(readMailgunApiBase("https://api.eu.mailgun.net/")).toBe("https://api.eu.mailgun.net");
    // A PATH PREFIX IS NOT ONE OF THE REFUSED COMPONENTS: it concatenates correctly, and it is
    // what a proxy in front of the account looks like.
    expect(readMailgunApiBase("http://127.0.0.1:8025/mailgun-double")).toBe(
      "http://127.0.0.1:8025/mailgun-double",
    );
  });

  it("rejects a value that is not an absolute URL", () => {
    for (const raw of ["api.mailgun.net", "//api.mailgun.net", "not a url"]) {
      expect(() => readMailgunApiBase(raw), raw).toThrow(/MAILGUN_API_BASE/);
    }
  });
});

describe("mailgunCredentialWarning", () => {
  const email = (apiKey?: string, domain?: string, transport = "mailgun" as const) => ({
    transport,
    mailgunApiKey: apiKey,
    mailgunDomain: domain,
  });

  it("says nothing when the pair is complete, or when mailgun is not the transport", () => {
    expect(mailgunCredentialWarning(email("key-abc", "mg.example.org"))).toBeUndefined();
    expect(mailgunCredentialWarning({ ...email(), transport: "ses" })).toBeUndefined();
  });

  // THE DESIGN CORRECTION this function records: a half-configured pair used to REFUSE the boot,
  // which crash-looped a whole deployment over a mail key — the public surface held hostage to a
  // credential nothing on it needs. Now it is one loud line naming exactly what is missing, and
  // the 503 on the sender routes (deliversEmail) carries the enforcement.
  it("names exactly the missing key(s), and never throws", () => {
    expect(mailgunCredentialWarning(email(undefined, "mg.example.org"))).toContain(
      "MAILGUN_API_KEY",
    );
    expect(mailgunCredentialWarning(email(undefined, "mg.example.org"))).not.toContain(
      "MAILGUN_DOMAIN",
    );
    expect(mailgunCredentialWarning(email("key-abc", undefined))).toContain("MAILGUN_DOMAIN");
    const both = mailgunCredentialWarning(email());
    expect(both).toContain("MAILGUN_API_KEY and MAILGUN_DOMAIN");
    expect(both).toContain("503");
    expect(both).toContain("keeps");
  });
});

describe("readAnalyticsHmacKey", () => {
  it("uses a supplied key as-is", () => {
    expect(readAnalyticsHmacKey(" secret ")).toEqual({ key: "secret", generated: false });
  });

  // Unset is survivable — the hashes stay unlinkable — so it degrades rather than refusing. What
  // is lost is continuity across restarts, and the caller is told which case it is in.
  it("generates a per-boot key when unset, and says so", () => {
    const first = readAnalyticsHmacKey(undefined);
    const second = readAnalyticsHmacKey("");
    expect(first.generated).toBe(true);
    expect(first.key).toMatch(/^[0-9a-f]{64}$/);
    expect(first.key).not.toBe(second.key);
  });
});

/**
 * The four knobs that decide how often the corpus is re-checked and what one night of it costs.
 * They are asserted as SHIPPED VALUES rather than as readers because the defaults are the contract:
 * a deployment that sets none of them still re-checks every entry monthly, 500 at a time, a second
 * apart per host, keeping at most five runs each — and `docs/deploy.md` publishes exactly these
 * numbers.
 */
describe("the verification schedule's shipped defaults", () => {
  it("re-checks monthly, caps a night at 500 entries, and keeps five runs", () => {
    expect(config.verification.recheckDays).toBe(30);
    expect(config.verification.nightlyLimit).toBe(500);
    expect(config.verification.runsKeep).toBe(5);
  });

  /**
   * The default gap is spelled in two places — `HOST_MIN_GAP_MS`, which is the pacer's own default
   * and what its unit tests read, and the literal in `config.ts`, which is deliberately not an
   * import because configuration sits below the service layer. This is the guard that keeps the two
   * from drifting apart, which is the only thing wrong with spelling a number twice.
   */
  it("paces same-host fetches at the pacer's own default", () => {
    expect(config.verification.hostGapMs).toBe(HOST_MIN_GAP_MS);
  });
});

/**
 * ZERO IS A VALUE, not a missing one, and that is the whole reason this reader exists next to
 * `readPositiveInt`: `VERIFY_HOST_MIN_GAP_MS=0` is how the e2e stack says "there is no stranger to
 * be polite to here", and a reader that treated 0 as absent would silently pace it anyway.
 */
describe("readNonNegativeInt", () => {
  it("accepts zero, rejects negatives and non-integers, and falls back on blanks", () => {
    expect(readNonNegativeInt("0", 1_000)).toBe(0);
    expect(readNonNegativeInt("250", 1_000)).toBe(250);
    expect(readNonNegativeInt("-1", 1_000)).toBe(1_000);
    expect(readNonNegativeInt("1.5", 1_000)).toBe(1_000);
    expect(readNonNegativeInt("soon", 1_000)).toBe(1_000);
    expect(readNonNegativeInt("", 1_000)).toBe(1_000);
    expect(readNonNegativeInt(undefined, 1_000)).toBe(1_000);
  });
});
