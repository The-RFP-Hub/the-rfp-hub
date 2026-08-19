/**
 * A real browser sign-in, through the dashboard's own form.
 *
 * WHAT GOT SIMPLER, AND WHY IT MATTERS. This used to drive a third party's modal: a dialog whose
 * DOM we did not own, rendered by a script we did not ship, reached through selectors that had to be
 * discovered by probing a live tenant and that could change without warning. It needed a fixed test
 * address and a fixed code held in the environment, and it carried a workaround for a focus race
 * across six one-character inputs — a bug in somebody else's component that this suite had to model.
 *
 * The form is ours now. One email field, one code field, two buttons, labels we wrote. The failure
 * artifacts are kept exactly as they were (screenshot, the first 2000 characters of visible text,
 * and the console log) because those earned their place the first time this ran; what is gone is
 * everything that existed to cope with not owning the page.
 *
 * The code is read out of the run's outbox rather than held in the environment, so this needs no
 * configuration at all — and, unlike a fixed tenant code, each one is single-use and belongs to
 * exactly one address.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Browser, Page } from "@playwright/test";
import { register } from "../redact.js";
import { waitForOtp } from "./outbox.js";

export interface BrowserLoginInput {
  browser: Browser;
  dashboardUrl: string;
  apiUrl: string;
  /** The address to sign in as. Created on first use; no prior provisioning. */
  email: string;
  /** The run's outbox — where the API writes the code this login will type. */
  outboxDir: string;
  /** Where `storageState` is written. Under the run's 0700 directory, never in the repo. */
  storageStatePath: string;
  failureScreenshotPath: string;
  consoleLogPath?: string;
  timeoutMs?: number;
}

export interface BrowserLoginResult {
  storageStatePath: string;
  /** The signed session token the page ended up holding. */
  token: string;
  /** `auth_user.id` for the signed-in identity. */
  userId: string;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/** Where the dashboard keeps the session token. `SESSION_STORAGE_KEY` in `lib/auth-client.ts`. */
const SESSION_STORAGE_KEY = "rfphub.session-token";

export async function login(input: BrowserLoginInput): Promise<BrowserLoginResult> {
  const timeout = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const context = await input.browser.newContext();
  const page = await context.newPage();

  const consoleLines: string[] = [];
  if (input.consoleLogPath) {
    page.on("console", (message) => consoleLines.push(`[${message.type()}] ${message.text()}`));
    page.on("pageerror", (error) => consoleLines.push(`[pageerror] ${error.message}`));
    page.on("requestfailed", (request) =>
      consoleLines.push(
        `[requestfailed] ${request.url()} — ${request.failure()?.errorText ?? "unknown"}`,
      ),
    );
  }

  // The Bearer the page puts on its own first `/v1/me`. Kept as a cross-check against what ends up
  // in storage: the two disagreeing would mean the client sent a credential it did not persist,
  // which is the sort of thing that only shows up as a mysterious 401 three specs later.
  let harvested: string | undefined;
  page.on("request", (request) => {
    if (harvested) return;
    if (!request.url().startsWith(input.apiUrl) || !request.url().includes("/v1/me")) return;
    const bearer = request.headers().authorization?.replace(/^Bearer\s+/i, "");
    if (bearer) harvested = bearer;
  });

  try {
    await page.goto(input.dashboardUrl, { waitUntil: "domcontentloaded", timeout });

    // WAIT FOR THE SESSION TO RESOLVE FIRST. The front page is the public directory now, and the
    // header shows "restoring session…" until the client has decided whether anybody is signed in.
    // The `Log in` control does not exist before that, so filling a field straight away races a
    // page that has not finished deciding what to render.
    const logIn = page.getByRole("button", { name: "Log in" }).first();
    await logIn.waitFor({ state: "visible", timeout });
    await logIn.click();

    // The form is a dialog, not part of the page: `session.login` opens it (see `lib/auth-root.tsx`).
    await page.getByLabel("Email address", { exact: true }).fill(input.email);
    await page.getByRole("button", { name: "Send code" }).click();

    // The code exists only because the API just wrote it. Waiting for the field first means a slow
    // send cannot be mistaken for a missing one.
    const codeField = page.getByLabel(/digit code/i);
    await codeField.waitFor({ state: "visible", timeout });
    const otp = await waitForOtp(input.outboxDir, input.email, { timeoutMs: timeout });
    await codeField.fill(otp);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();

    // `Log out` is the product's own signal that the session was established.
    await page.getByRole("button", { name: "Log out" }).waitFor({ state: "visible", timeout });

    // …and the sections navigation renders only after `/v1/me` resolves, so waiting for a
    // capability-gated link is what proves the API accepted this browser's token — not merely that
    // the code was correct. `Directory` would not do: it is public and present for a stranger.
    await page.getByRole("link", { name: "Listings", exact: true }).waitFor({
      state: "visible",
      timeout,
    });

    const stored = await page.evaluate(
      (key) => globalThis.localStorage?.getItem(key) ?? null,
      SESSION_STORAGE_KEY,
    );
    if (!stored) {
      throw new Error(
        "browser-login: signed in, but no session token is in storage. Every later browser " +
          "assertion would run without a credential.",
      );
    }
    if (harvested && harvested !== stored) {
      throw new Error(
        "browser-login: the token the page SENT differs from the token it STORED. One of the two is " +
          "stale, and which one wins would decide whether later requests authenticate.",
      );
    }
    register(stored, { label: "session-token", longLived: false });

    mkdirSync(dirname(input.storageStatePath), { recursive: true, mode: 0o700 });
    await context.storageState({ path: input.storageStatePath });

    return {
      storageStatePath: input.storageStatePath,
      token: stored,
      userId: await subjectOf(page, input.apiUrl, stored),
    };
  } catch (err) {
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
 * The signed-in identity's `auth_user.id`.
 *
 * Asked of the API rather than decoded out of the token: the session token is an opaque value plus
 * an HMAC, not a JWT with readable claims, so there is nothing in it to decode. That opacity is a
 * property worth having — it is why a leaked token discloses no user id — and this is the price.
 */
async function subjectOf(page: Page, apiUrl: string, token: string): Promise<string> {
  const session = await page.evaluate(
    async ([url, bearer]) => {
      const response = await fetch(`${url}/api/auth/get-session`, {
        headers: { authorization: `Bearer ${bearer}` },
      });
      return response.ok ? ((await response.json()) as { user?: { id?: string } }) : null;
    },
    [apiUrl, token] as const,
  );
  const id = session?.user?.id;
  if (!id) throw new Error("browser-login: the session carries no user id");
  return id;
}
