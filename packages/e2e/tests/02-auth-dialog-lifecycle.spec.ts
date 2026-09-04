/** Native-dialog lifecycle over real Chromium hit-testing, which jsdom cannot model. */
import { expect, test } from "../src/fixtures.js";
import { waitForOtp } from "../src/identity/outbox.js";

test("the sign-in modal releases the page and opens again after logout", async ({
  browser,
  stack,
}) => {
  // The chromium project carries the publisher's storageState. This case must begin anonymous so
  // it can exercise the product's own sign-in dialog, not merely adopt the project session.
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  const email = `dialog-lifecycle-${Date.now()}@rfphub.invalid`;

  try {
    await page.goto(stack.urls.frontend);
    await page.getByRole("button", { name: "Log in" }).first().click();
    await page.getByLabel("Email address", { exact: true }).fill(email);
    await page.getByRole("button", { name: "Send code" }).click();

    const code = page.getByLabel(/digit code/i);
    await expect(code).toBeVisible();
    await code.fill(await waitForOtp(stack.outboxDir, email));
    await page.getByRole("button", { name: "Sign in", exact: true }).click();

    await expect(page.getByRole("dialog", { name: "Log in" })).toBeHidden();
    // A modal makes everything outside it inert and removes the header from the accessibility tree.
    // Seeing the banner again proves successful sign-in released the browser top layer.
    await expect(page.getByRole("banner")).toBeVisible();

    await page.getByRole("button", { name: /navigation menu/i }).click();
    await page.getByRole("button", { name: "Log out" }).click();
    const logInAgain = page.getByRole("button", { name: "Log in" }).first();
    await expect(logInAgain).toBeVisible();

    // Playwright's click is a pointer action. It cannot hit an element behind a stale modal, while
    // `element.click()` could — exactly the distinction that exposed this regression manually.
    await logInAgain.click();
    await expect(page.getByRole("dialog", { name: "Log in" })).toBeVisible();
  } finally {
    await context.close();
  }
});
