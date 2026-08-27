/**
 * M4 — mobile-responsive evidence for the public reference frontend.
 *
 * THIS IS THE FIRST RESPONSIVE TEST IN THE REPOSITORY. `globals.css` has carried breakpoints
 * (40rem/56rem/30rem) and a `(pointer: coarse)` touch-target rule for a while, but nothing ever
 * exercised them in a real browser at a real viewport — so a regression in either would have shipped
 * silent. This file is that evidence, for the three public pages the reference frontend's own README
 * calls the front door: the directory (`/`), one entry (`/opportunities/{id}`), and the publisher
 * directory (`/publishers`).
 *
 * `/publishers` MAY NOT EXIST YET in every checkout — it is another M4 stream's route. Its checks
 * SOFT-SKIP, but only on an EXACT 404: that response is reported with a clear message and skipped,
 * while `/` and `/opportunities/{id}` are always asserted. Anything else the route could answer — no
 * response at all, a non-404 error status, or a 200 that renders no heading naming publishers — is a
 * hard failure, never folded into the same skip; a checkout that has landed `/publishers` gets full
 * coverage automatically, with no flag to flip.
 *
 * EVERY CASE RUNS IN A CONTEXT BUILT FRESH, sized to the viewport under test and with no stored
 * session — these are public, unauthenticated pages, and the project's shared `storageState` would
 * only be a confound here. `hasTouch` is set for the two narrower viewports so the CSS's own
 * `(pointer: coarse)` rule — which is what actually widens a control to the 44px touch target this
 * file checks — takes effect exactly the way a real phone or tablet would trigger it; the desktop
 * viewport runs with a mouse pointer, which is the point of including it as a contrast case.
 */
import type { Browser, Locator, Page } from "@playwright/test";
import { expect, skipUnlessActor, test } from "../src/fixtures.js";

test.describe.configure({ mode: "serial" });

interface Viewport {
  name: string;
  width: number;
  height: number;
  /** Only the two touch-sized viewports flip on `(pointer: coarse)` — see the module comment. */
  hasTouch: boolean;
}

const VIEWPORTS: Viewport[] = [
  { name: "mobile (375×667)", width: 375, height: 667, hasTouch: true },
  { name: "tablet (768×1024)", width: 768, height: 1024, hasTouch: true },
  { name: "desktop (1440×900)", width: 1440, height: 900, hasTouch: false },
];

/** The minimum a touch target must clear — `--control-touch` in `globals.css`, restated here because
 *  the point of this file is to prove the CSS value in a real browser rather than to trust it. */
const MIN_TOUCH_TARGET_PX = 44;

async function newViewportPage(
  browser: Browser,
  viewport: Viewport,
): Promise<{ context: Awaited<ReturnType<Browser["newContext"]>>; page: Page }> {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    hasTouch: viewport.hasTouch,
    // `hasTouch` ALONE does not flip Chromium's `pointer`/`hover` media features — it only adds
    // touch-event dispatch. `isMobile` is what actually makes `(pointer: coarse)` match, which is
    // the rule `globals.css` uses to widen a control to its 44px touch target. Confirmed the hard
    // way: without this, the mobile-viewport run below measured a 40px control and failed.
    isMobile: viewport.hasTouch,
    storageState: undefined,
  });
  return { context, page: await context.newPage() };
}

/**
 * `document.documentElement.scrollWidth <= innerWidth` — a page that must not scroll sideways.
 *
 * `globalThis`, not `window`/`document` by name: this package's `tsconfig.json` has no DOM lib (it
 * is a Node runner and its specs run in Node too — only the callback below actually executes in the
 * browser), so every other spec in this suite that reaches into page globals goes through the same
 * cast rather than widening the whole package's `lib` for one evaluate call.
 */
async function expectNoHorizontalOverflow(page: Page, where: string): Promise<void> {
  const { scrollWidth, innerWidth } = await page.evaluate(() => {
    const browser = globalThis as unknown as {
      document: { documentElement: { scrollWidth: number } };
      innerWidth: number;
    };
    return {
      scrollWidth: browser.document.documentElement.scrollWidth,
      innerWidth: browser.innerWidth,
    };
  });
  expect(
    scrollWidth,
    `${where}: document.documentElement.scrollWidth (${scrollWidth}) must not exceed window.innerWidth (${innerWidth})`,
  ).toBeLessThanOrEqual(innerWidth);
}

/** Visible, and at least `MIN_TOUCH_TARGET_PX` tall — the shape of every touch-target assertion below. */
async function expectTouchTarget(locator: Locator, label: string): Promise<void> {
  await expect(locator, `${label} must be visible`).toBeVisible();
  const box = await locator.boundingBox();
  expect(box, `${label}: could not read a bounding box`).not.toBeNull();
  expect(
    box?.height ?? 0,
    `${label}: bounding box height (${box?.height}) must be at least ${MIN_TOUCH_TARGET_PX}px`,
  ).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
}

/**
 * Waits for a `ResourceView`-driven read to SETTLE before anything measures layout against it.
 *
 * `states.tsx`'s `Loading` placeholder (`output.state.loading`) is a deliberately minimal,
 * fixed-height box — measuring overflow against it proves nothing about the page a reader actually
 * sees. `content` is whatever locator proves THIS page's real data rendered (a fixture's own row or
 * card); the shared empty (`.state.empty`) and error (`.callout.state.error`) containers race
 * against it too, because either of those is just as much a "loaded" outcome as content is. Once one
 * of the three wins, the loading placeholder itself must actually be gone — `useResource` never
 * renders it alongside a result, but this is what proves that rather than assuming it.
 */
async function waitForLoaded(page: Page, content: Locator, timeout = 20_000): Promise<void> {
  await Promise.any([
    content.first().waitFor({ state: "visible", timeout }),
    page.locator(".state.empty").first().waitFor({ state: "visible", timeout }),
    page.locator(".callout.state.error").first().waitFor({ state: "visible", timeout }),
  ]);
  await expect(page.locator("output.state.loading")).toHaveCount(0);
}

/**
 * The `/publishers` equivalent of `waitForLoaded`, for a page this repository cannot inspect (it
 * may not exist here at all — see the module comment). Without a page-specific "real content"
 * locator to race against empty/error, this settles for the two page-shape-agnostic signals
 * available: the shared loading placeholder actually clearing if it ever appeared, and the
 * browser's own network-idle signal as a second, independent proxy for the page's initial fetch
 * having settled.
 */
async function waitForResourceSettled(page: Page): Promise<void> {
  const loading = page.locator("output.state.loading").first();
  const appeared = await loading
    .waitFor({ state: "visible", timeout: 3_000 })
    .then(() => true)
    .catch(() => false);
  if (appeared) await loading.waitFor({ state: "hidden", timeout: 20_000 });
  await page.waitForLoadState("networkidle").catch(() => undefined);
}

/** The directory's main filter controls — the ones a thumb actually has to hit on a phone. */
async function expectDirectoryControlsAreTouchable(page: Page): Promise<void> {
  await expectTouchTarget(page.getByLabel("Search", { exact: true }), "the Search box");
  await expectTouchTarget(page.getByLabel("Status", { exact: true }), "the Status select");
  await expectTouchTarget(page.getByLabel("Organization", { exact: true }), "the Organization box");
  await expectTouchTarget(page.getByRole("button", { name: "Search" }), "the Search button");
}

test.describe("M4 responsive layout", () => {
  test.beforeEach(({ stack }) => {
    // Only a publisher is needed: one published entry is enough to exercise the detail page. See
    // `m3-7-public-browse.spec.ts` for the same shape of setup.
    skipUnlessActor(stack, "publisher");
  });

  for (const viewport of VIEWPORTS) {
    test(`${viewport.name} — the directory, an entry, and (if present) /publishers`, async ({
      browser,
      stack,
      api,
      opportunityFixture,
    }) => {
      const publisher = await api("publisher");
      const stamp = Date.now();
      const document = opportunityFixture(stack.namespaces.publisher, `responsive-${stamp}`, {
        title: `Responsive layout probe ${stamp}`,
        // `seedDocument`'s default carries `applicationUrl` but not `website` — and the "Programme
        // site" (source) link only renders when `website` is set. Both are asserted below, so both
        // need to be true of this fixture.
        website: stack.urls.programme,
      });
      const id = document.id as string;
      const created = await publisher.post("/v1/opportunities", document);
      expect(created.status, "the fixture entry must publish").toBe(201);

      const { context, page } = await newViewportPage(browser, viewport);
      const isMobile = viewport.width === 375;

      try {
        // ── `/` — the directory ──────────────────────────────────────────────────────────────
        // The heading is STATIC markup rendered beside `<DirectoryList/>`, not inside the
        // `ResourceView` it drives (`app/page.tsx`) — it is visible well before the list's own
        // fetch resolves, so it proves nothing about whether real content has rendered yet.
        // `waitForLoaded` below, racing this fixture's own row against the shared empty/error
        // containers, is what actually proves the page a reader would see rather than a loading
        // skeleton.
        await page.goto(stack.urls.frontend);
        await expect(page.getByRole("heading", { name: "Funding opportunities" })).toBeVisible();
        const listedEntry = page.getByRole("link", {
          name: new RegExp(`Responsive layout probe ${stamp}`),
        });
        await waitForLoaded(page, listedEntry);
        await expect(listedEntry).toBeVisible();
        await expectNoHorizontalOverflow(page, "/");

        if (isMobile) {
          // Only asserted at the phone width: this is where a cramped filter bar actually bites,
          // and where the CSS's `(pointer: coarse)` rule is doing the work being checked.
          await expectDirectoryControlsAreTouchable(page);
        }

        // ── `/opportunities/{id}` — one entry ────────────────────────────────────────────────
        await page.goto(`${stack.urls.frontend}/opportunities/${encodeURIComponent(id)}`);
        const apply = page.getByRole("link", { name: /Apply on the programme’s own site/ });
        // The apply action only renders once the entry's own data has loaded, so this doubles as
        // the content signal `waitForLoaded` races against empty/error.
        await waitForLoaded(page, apply);
        await expect(apply).toBeVisible();
        await expectNoHorizontalOverflow(page, `/opportunities/${id}`);

        if (isMobile) {
          await expectTouchTarget(apply, "the Apply link");
          const source = page.getByRole("link", { name: "Programme site" });
          await expectTouchTarget(source, "the Programme site (source) link");
        }

        // "/publishers" soft-skips ONLY on an exact 404: this route belongs to another M4
        // stream and may not exist yet in this checkout. Anything else -- no response at all, a
        // non-404 error status, or a 200 that does not actually render the page -- is a hard
        // failure and must never be folded into the same skip.
        const response = await page.goto(`${stack.urls.frontend}/publishers`);
        if (response?.status() === 404) {
          test.info().annotations.push({
            type: "skip-reason",
            description:
              "SKIPPED /publishers: the route answers 404 here (another M4 stream owns it). " +
              "The directory and the entry page above were still asserted at this viewport.",
          });
          console.log(
            `[m4-responsive] ${viewport.name}: /publishers answers 404 here -- skipping its assertions, not the whole test.`,
          );
        } else {
          expect(
            response,
            "/publishers: the navigation produced no response at all (a network or connection " +
              "failure) -- that is a hard failure, not the same thing as the route being absent",
          ).not.toBeNull();
          expect(
            response?.status(),
            `/publishers: expected either a 404 (route absent here) or a successful response; got ${response?.status()}`,
          ).toBeLessThan(400);
          await expect(
            page.getByRole("heading", { name: /publisher/i }).first(),
            "/publishers: responded, but no heading naming publishers was found -- a blank or " +
              "broken page must fail this test, not be treated as the route being absent",
          ).toBeVisible();
          // The heading can be static markup beside the page's own `ResourceView`, exactly like the
          // directory's — so it says the route rendered SOMETHING, not that its data has loaded.
          // `waitForResourceSettled` is the page-shape-agnostic wait for that (see its own comment
          // for why this page gets a different helper from `/` and the entry page above).
          await waitForResourceSettled(page);
          await expectNoHorizontalOverflow(page, "/publishers");
        }
      } finally {
        await context.close();
      }
    });
  }
});
