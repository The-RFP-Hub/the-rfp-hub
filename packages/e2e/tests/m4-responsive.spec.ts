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
 * `/publishers` MAY NOT EXIST YET in every worktree — it is another M4 stream's route. Its checks are
 * SOFT: a 404 there is reported with a clear message and skipped, while `/` and `/opportunities/{id}`
 * are always asserted. A worktree that has landed `/publishers` gets full coverage automatically, with
 * no flag to flip.
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
        await page.goto(stack.urls.frontend);
        await expect(page.getByRole("heading", { name: "Funding opportunities" })).toBeVisible();
        await expectNoHorizontalOverflow(page, "/");

        if (isMobile) {
          // Only asserted at the phone width: this is where a cramped filter bar actually bites,
          // and where the CSS's `(pointer: coarse)` rule is doing the work being checked.
          await expectDirectoryControlsAreTouchable(page);
        }

        // ── `/opportunities/{id}` — one entry ────────────────────────────────────────────────
        await page.goto(`${stack.urls.frontend}/opportunities/${encodeURIComponent(id)}`);
        const apply = page.getByRole("link", { name: /Apply on the programme’s own site/ });
        await expect(apply).toBeVisible();
        await expectNoHorizontalOverflow(page, `/opportunities/${id}`);

        if (isMobile) {
          await expectTouchTarget(apply, "the Apply link");
          const source = page.getByRole("link", { name: "Programme site" });
          await expectTouchTarget(source, "the Programme site (source) link");
        }

        // ── `/publishers` — soft: this route belongs to another M4 stream ───────────────────
        const response = await page.goto(`${stack.urls.frontend}/publishers`);
        if (!response || response.status() === 404) {
          test.info().annotations.push({
            type: "skip-reason",
            description:
              "SKIPPED /publishers: the route answers 404 in this worktree (another M4 stream owns " +
              "it). The directory and the entry page above were still asserted at this viewport.",
          });
          console.log(
            `[m4-responsive] ${viewport.name}: /publishers is not present in this worktree (404) — skipping its assertions, not the whole test.`,
          );
        } else {
          await expectNoHorizontalOverflow(page, "/publishers");
        }
      } finally {
        await context.close();
      }
    });
  }
});
