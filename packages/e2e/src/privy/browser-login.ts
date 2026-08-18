/**
 * A real browser login through the dashboard's own identity modal.
 *
 * This is the ONLY thing in the suite that proves the browser half of the session: a token minted
 * server-side proves the API accepts a Privy-signed token, but it says nothing about whether a
 * person can sign in to the dashboard and reach a gated page. So this drives the actual modal, in
 * a real Chromium, against the real identity provider.
 *
 * **Email OTP is the only automatable method**, and not by choice: the dashboard configures
 * `loginMethods: ["wallet", "email"]` (`packages/dashboard/src/lib/privy-root.tsx`). A wallet login
 * needs a wallet extension or a WalletConnect peer, and SMS is not among the configured methods —
 * enabling it would mean editing production code for a test's convenience, which this suite does
 * not do. That leaves email, which is why `E2E_PRIVY_TEST_EMAIL` and `E2E_PRIVY_TEST_OTP` are the
 * two variables that gate every browser criterion.
 *
 * TWO THINGS ARE HARVESTED, and both matter:
 *   - `storageState`, so every later browser context starts signed in without repeating the modal;
 *   - the Bearer the page itself puts on its first `/v1/me` request. That token is a genuine
 *     provider-issued access token for the browser identity, and at the browser-only level it is
 *     the run's only source of real tokens — the API-layer specs for that identity use it rather
 *     than falling back to anything locally signed.
 *
 * HONESTY NOTE. The selectors below are written against the modal the installed SDK renders. They
 * are resilient (role- and label-based, with a documented fallback order) but they are, in the end,
 * selectors on a third party's UI. When this function fails, it fails LOUDLY with a screenshot and
 * the page's accessible text — it never returns a half-session that a later spec would misread as a
 * successful login.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Browser, Page } from "@playwright/test";
import { register } from "../redact.js";

export interface BrowserLoginInput {
  browser: Browser;
  dashboardUrl: string;
  apiUrl: string;
  email: string;
  otp: string;
  /** Where `storageState` is written. Under the run's 0700 temp directory, never in the repo. */
  storageStatePath: string;
  /** Screenshot destination when the login fails. */
  failureScreenshotPath: string;
  /** Where the page's console output and uncaught errors are written. */
  consoleLogPath?: string;
  /**
   * Whether to wait for the API to accept the session as well as the provider.
   *
   * False for exactly one case: the throwaway login at the browser-only level, which happens BEFORE
   * the API exists because its whole purpose is to learn the DID the API must be booted with. The
   * page still issues its `/v1/me` — a request is observable whether or not anything answers it —
   * so the Bearer is still harvested; there is simply no navigation to wait for.
   */
  awaitApiSession?: boolean;
  timeoutMs?: number;
}

export interface BrowserLoginResult {
  storageStatePath: string;
  /** The Bearer the page sent on its own first `/v1/me`. A genuine provider-issued token. */
  token: string;
  /** The DID that token carries, decoded locally. */
  did: string;
}

const DEFAULT_TIMEOUT_MS = 90_000;

/**
 * Signs in and returns the harvested session material.
 *
 * The `/v1/me` listener is attached BEFORE the login is driven: the dashboard fires that request as
 * soon as the session is restored, and a listener attached afterwards would miss it and then wait
 * out the whole timeout for a request that already happened.
 */
export async function login(input: BrowserLoginInput): Promise<BrowserLoginResult> {
  const timeout = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const context = await input.browser.newContext();
  const page = await context.newPage();

  // The page's own console and uncaught errors, kept for the whole login.
  //
  // The identity modal pulls in a large wallet-connector bundle, and that bundle is where this
  // project's transitive dependency risk actually lives. A warning or a failed import there is
  // invisible in a passing test — the login still succeeds — so it is recorded rather than
  // discarded, and a dependency bump can be checked against it.
  const consoleLines: string[] = [];
  if (input.consoleLogPath) {
    page.on("console", (message) => {
      consoleLines.push(`[${message.type()}] ${message.text()}`);
    });
    page.on("pageerror", (error) => {
      consoleLines.push(`[pageerror] ${error.message}`);
    });
    page.on("requestfailed", (request) => {
      consoleLines.push(
        `[requestfailed] ${request.url()} — ${request.failure()?.errorText ?? "unknown"}`,
      );
    });
  }

  // Capture the Authorization header of the first /v1/me the PAGE issues. `page.on("request")` sees
  // the outgoing headers, which is the only place this token is observable — the response does not
  // echo it and the SDK keeps it in memory.
  let harvested: string | undefined;
  page.on("request", (request) => {
    if (harvested) return;
    if (!request.url().startsWith(input.apiUrl)) return;
    if (!request.url().includes("/v1/me")) return;
    const header = request.headers().authorization;
    const bearer = header?.replace(/^Bearer\s+/i, "");
    if (bearer) {
      harvested = bearer;
      register(bearer, { label: "privy-access-token", longLived: false });
    }
  });

  try {
    await page.goto(input.dashboardUrl, { waitUntil: "domcontentloaded", timeout });

    // Two "Log in" buttons exist — the header's and the page body's — and either opens the same
    // dialog, so the first is taken deliberately rather than by accident.
    await page.getByRole("button", { name: "Log in" }).first().click({ timeout });

    // THE DIALOG RENDERS IN THE MAIN DOCUMENT (`#privy-dialog`), not in an iframe. The page does
    // host an `auth.privy.io` iframe, but it is the embedded-wallet frame and has nothing to do with
    // this flow — a `frameLocator` aimed at it finds no fields at all.
    const email = page.locator("#email-input, input[type='email']").first();
    await email.waitFor({ state: "visible", timeout });
    await email.fill(input.email);
    await email.press("Enter");

    await enterOtp(page, input.otp, timeout);

    // The dashboard shows `Log out` once the session is established — the product's own signal that
    // the login completed, rather than a guess about the modal's closing animation.
    await page.getByRole("button", { name: "Log out" }).waitFor({ state: "visible", timeout });

    if (input.awaitApiSession !== false) {
      // The navigation renders only after `/v1/me` resolves, so waiting for a nav link is what
      // proves the API accepted the browser's token — not merely that the provider accepted the OTP.
      await page.getByRole("link", { name: "Listings" }).waitFor({ state: "visible", timeout });
    } else {
      // No API to answer yet. The request still LEAVES the page, which is all this call needs; give
      // it a moment to be issued rather than racing the assertion below.
      await page.waitForTimeout(2_000);
    }

    if (!harvested) {
      throw new Error(
        "browser-login: signed in, but no Authorization header was observed on a /v1/me request. " +
          "The API-layer specs for the browser identity have no token to use.",
      );
    }

    mkdirSync(dirname(input.storageStatePath), { recursive: true, mode: 0o700 });
    await context.storageState({ path: input.storageStatePath });

    return {
      storageStatePath: input.storageStatePath,
      token: harvested,
      did: subjectOf(harvested),
    };
  } catch (err) {
    // A failure here decides a ladder level, so it is worth a real artifact rather than a message.
    await page
      .screenshot({ path: input.failureScreenshotPath, fullPage: true })
      .catch(() => undefined);
    const visible = await page
      .locator("body")
      .innerText()
      .catch(() => "(page text unavailable)");
    throw new Error(
      `browser-login failed: ${(err as Error).message}\n` +
        `A screenshot is at ${input.failureScreenshotPath}.\n` +
        `--- visible page text ---\n${visible.slice(0, 2_000)}`,
    );
  } finally {
    if (input.consoleLogPath && consoleLines.length > 0) {
      mkdirSync(dirname(input.consoleLogPath), { recursive: true, mode: 0o700 });
      writeFileSync(input.consoleLogPath, `${consoleLines.join("\n")}\n`, { mode: 0o600 });
    }
    await context.close();
  }
}

/**
 * Enters the one-time code.
 *
 * The confirmation step renders SIX separate single-character inputs, named `code-0` … `code-5`.
 * They are filled ONE AT A TIME, and that is not a stylistic choice: typing the whole code at the
 * keyboard puts every character into whichever box holds focus, because the component moves focus
 * on its own `input` event and the synthetic keystrokes outrun it. The observable result is a single
 * digit — the last one — sitting in the first box while the other five stay empty, and a login that
 * simply never completes. Addressing each box by name is deterministic and needs no timing luck.
 *
 * The step is waited for BY ITS HEADING first. The email input remains in the DOM behind the
 * dialog, so a locator that merely counts inputs can sample the previous screen and conclude there
 * is one box rather than six.
 */
async function enterOtp(page: Page, otp: string, timeout: number): Promise<void> {
  await page.getByText(/Enter confirmation code/i).waitFor({ state: "visible", timeout });

  const boxes = page.locator("input[name^='code-']");
  await boxes.first().waitFor({ state: "visible", timeout });

  const count = await boxes.count();
  if (count >= otp.length) {
    for (let index = 0; index < otp.length; index++) {
      await boxes.nth(index).fill(otp[index] as string);
    }
    return;
  }

  // A single field carrying the whole code — the other shape this provider has shipped. Kept as a
  // fallback so a UI change degrades to a different working path rather than to a failure.
  const single = page.getByRole("textbox").first();
  await single.fill(otp);
  await single.press("Enter");
}

/** Decodes a JWT's `sub` without verifying it — this token was just observed being accepted. */
function subjectOf(token: string): string {
  const segment = token.split(".")[1];
  if (!segment) throw new Error("browser-login: harvested credential is not a JWT");
  const json = Buffer.from(segment.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(
    "utf8",
  );
  const claims = JSON.parse(json) as { sub?: string };
  if (!claims.sub) throw new Error("browser-login: harvested token carries no `sub` claim");
  return claims.sub;
}
