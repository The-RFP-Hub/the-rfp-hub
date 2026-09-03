/**
 * M4 — mobile-responsive evidence for the public directory, opportunity, publisher and explainer
 * pages.
 *
 * `globals.css` has carried breakpoints and a `(pointer: coarse)` touch-target rule for a while,
 * but nothing ever exercised them in a real browser at a real viewport. All three pages are
 * asserted unconditionally: a spec that folds one into a skip is a green gate that proved nothing.
 */
import type { Browser, Locator, Page } from "@playwright/test";
import { expect, skipUnlessActor, test } from "../src/fixtures.js";

test.describe.configure({ mode: "serial" });

interface Viewport {
  name: string;
  width: number;
  height: number;
  hasTouch: boolean;
}

const VIEWPORTS: Viewport[] = [
  { name: "mobile (375×667)", width: 375, height: 667, hasTouch: true },
  { name: "tablet (768×1024)", width: 768, height: 1024, hasTouch: true },
  { name: "desktop (1440×900)", width: 1440, height: 900, hasTouch: false },
];

/** `--control-touch`, restated rather than read: the point is to prove the value in a browser. */
const MIN_TOUCH_TARGET_PX = 44;

async function newViewportPage(
  browser: Browser,
  viewport: Viewport,
): Promise<{ context: Awaited<ReturnType<Browser["newContext"]>>; page: Page }> {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    hasTouch: viewport.hasTouch,
    // `hasTouch` alone only adds touch-event dispatch; `isMobile` is what makes `(pointer: coarse)`
    // match, and that is the rule being measured. Without it the mobile run measured a 40px control.
    isMobile: viewport.hasTouch,
    storageState: undefined,
  });
  return { context, page: await context.newPage() };
}

/** `globalThis` rather than `window`/`document`: this package's tsconfig has no DOM lib. */
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

async function expectTouchTarget(locator: Locator, label: string): Promise<void> {
  await expect(locator, `${label} must be visible`).toBeVisible();
  const box = await locator.boundingBox();
  expect(box, `${label}: could not read a bounding box`).not.toBeNull();
  expect(
    box?.height ?? 0,
    `${label}: bounding box height (${box?.height}) must be at least ${MIN_TOUCH_TARGET_PX}px`,
  ).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
}

/** Measuring layout against the fixed-height `Loading` placeholder proves nothing about the page a
 *  reader sees. `content` is this page's real data; empty and error race it, being just as settled. */
async function waitForLoaded(page: Page, content: Locator, timeout = 20_000): Promise<void> {
  await Promise.any([
    content.first().waitFor({ state: "visible", timeout }),
    page.locator(".state.empty").first().waitFor({ state: "visible", timeout }),
    page.locator(".callout.state.error").first().waitFor({ state: "visible", timeout }),
  ]);
  await expect(page.locator("output.state.loading")).toHaveCount(0);
}

/** `waitForLoaded` without a page-specific content locator: the shared placeholder clearing, plus
 *  network-idle as a second, independent proxy for the initial fetch having settled. */
async function waitForResourceSettled(page: Page): Promise<void> {
  const loading = page.locator("output.state.loading").first();
  const appeared = await loading
    .waitFor({ state: "visible", timeout: 3_000 })
    .then(() => true)
    .catch(() => false);
  if (appeared) await loading.waitFor({ state: "hidden", timeout: 20_000 });
  await page.waitForLoadState("networkidle").catch(() => undefined);
}

/** A layout that survives a narrow viewport and then hides its own navigation has not survived it. */
async function expectUsableNav(page: Page, viewport: Viewport): Promise<void> {
  const nav = page.getByRole("navigation", { name: "Sections" });
  await expect(nav, "the header navigation landmark must be present").toBeVisible();
  for (const label of ["Directory", "Publishers", "How it works"]) {
    const link = nav.getByRole("link", { name: label, exact: true });
    if (viewport.hasTouch) await expectTouchTarget(link, `the ${label} nav link`);
    else await expect(link, `the ${label} nav link must be visible`).toBeVisible();
  }
}

/** The directory's main filter controls — the ones a thumb actually has to hit on a phone. */
async function expectDirectoryControlsAreTouchable(page: Page): Promise<void> {
  await expectTouchTarget(page.getByLabel("Search", { exact: true }), "the Search box");
  await expectTouchTarget(page.getByLabel("Status", { exact: true }), "the Status select");
  await expectTouchTarget(page.getByRole("button", { name: "Search" }), "the Search button");

  const more = page.locator(".filters-more > summary");
  await expectTouchTarget(more, "the More filters disclosure");
  await more.click();
  await expectTouchTarget(page.getByLabel("Organization", { exact: true }), "the Organization box");
}

async function expectMobileDirectoryRowsToReflow(page: Page): Promise<void> {
  const result = await page.locator(".directory-table-scroll").evaluate((element) => {
    const browser = globalThis as unknown as {
      getComputedStyle: (target: unknown) => { overflowX: string };
    };
    return {
      fits: element.scrollWidth <= element.clientWidth,
      overflowX: browser.getComputedStyle(element).overflowX,
    };
  });
  expect(result.fits, "the mobile result list must not require horizontal scrolling").toBe(true);
  expect(
    result.overflowX,
    "the mobile result list must reflow instead of becoming a scroll box",
  ).toBe("visible");
}

test.describe("M4 responsive layout", () => {
  test.beforeEach(({ stack }) => {
    skipUnlessActor(stack, "publisher");
  });

  for (const viewport of VIEWPORTS) {
    test(`${viewport.name} — the directory, an entry, /publishers, and /how-it-works`, async ({
      browser,
      stack,
      api,
      opportunityFixture,
    }) => {
      const publisher = await api("publisher");
      const stamp = Date.now();
      const document = opportunityFixture(stack.namespaces.publisher, `responsive-${stamp}`, {
        title: `Responsive layout probe ${stamp}`,
        // The "Program site" link renders only when `website` is set, and it is asserted below.
        website: stack.urls.programme,
      });
      const id = document.id as string;
      const created = await publisher.post("/v1/opportunities", document);
      expect(created.status, "the fixture entry must publish").toBe(201);

      const { context, page } = await newViewportPage(browser, viewport);

      try {
        // The heading is static markup beside `<DirectoryList/>`, so it is visible long before the
        // list's own fetch resolves; `waitForLoaded` is what proves real content rendered.
        await page.goto(stack.urls.frontend);
        await expect(page.getByRole("heading", { name: "Funding opportunities" })).toBeVisible();
        const listedEntry = page.getByRole("link", {
          name: new RegExp(`Responsive layout probe ${stamp}`),
        });
        await waitForLoaded(page, listedEntry);
        await expect(listedEntry).toBeVisible();
        await expectNoHorizontalOverflow(page, "/");
        await expectUsableNav(page, viewport);

        // Both touch viewports: 768×1024 also runs `isMobile`, so the same rule has to hold there.
        if (viewport.hasTouch) await expectDirectoryControlsAreTouchable(page);
        if (viewport.width <= 640) await expectMobileDirectoryRowsToReflow(page);

        await page.goto(`${stack.urls.frontend}/opportunities/${encodeURIComponent(id)}`);
        // The apply action renders only once the entry's data has loaded, so it doubles as the
        // content signal `waitForLoaded` races against empty/error.
        const apply = page.getByRole("link", { name: /Apply on the program’s own site/ });
        await waitForLoaded(page, apply);
        await expect(apply).toBeVisible();
        await expectNoHorizontalOverflow(page, `/opportunities/${id}`);
        await expectUsableNav(page, viewport);

        if (viewport.hasTouch) {
          await expectTouchTarget(apply, "the Apply link");
          const source = page.getByRole("link", { name: "Program site" });
          await expectTouchTarget(source, "the Program site (source) link");
        }

        const response = await page.goto(`${stack.urls.frontend}/publishers`);
        expect(
          response,
          "/publishers: the navigation produced no response at all (a network or connection failure)",
        ).not.toBeNull();
        expect(
          response?.status(),
          `/publishers: expected a successful response; got ${response?.status()}`,
        ).toBeLessThan(400);
        await expect(
          page.getByRole("heading", { name: /publisher/i }).first(),
          "/publishers: responded, but no heading naming publishers was found",
        ).toBeVisible();
        await waitForResourceSettled(page);
        await expectNoHorizontalOverflow(page, "/publishers");
        await expectUsableNav(page, viewport);

        await page.goto(`${stack.urls.frontend}/how-it-works`);
        await expect(page.getByRole("heading", { name: "How the Hub works" })).toBeVisible();
        await expect(page.getByRole("heading", { name: "Who can do what" })).toBeVisible();
        await expectNoHorizontalOverflow(page, "/how-it-works");
        await expectUsableNav(page, viewport);
      } finally {
        await context.close();
      }
    });
  }
});
