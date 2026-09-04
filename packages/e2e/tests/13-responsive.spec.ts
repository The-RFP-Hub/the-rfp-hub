/**
 * M4 — mobile-responsive evidence for the public directory, opportunity, publisher and explainer
 * pages.
 *
 * `globals.css` has carried breakpoints and a `(pointer: coarse)` touch-target rule for a while,
 * but nothing ever exercised them in a real browser at a real viewport. All three pages are
 * asserted unconditionally: a spec that folds one into a skip is a green gate that proved nothing.
 */
import type { Browser, Locator, Page } from "@playwright/test";
import { expect, skipUnlessActor, skipUnlessBrowserSession, test } from "../src/fixtures.js";

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

/** The advanced filter regression appeared between the old phone/desktop probes, around 1220px. */
const ADVANCED_FILTER_VIEWPORTS: Viewport[] = [
  { name: "mobile minimum (320×720)", width: 320, height: 720, hasTouch: true },
  { name: "mobile (375×812)", width: 375, height: 812, hasTouch: true },
  { name: "mobile wide (390×844)", width: 390, height: 844, hasTouch: true },
  { name: "tablet (768×1024)", width: 768, height: 1024, hasTouch: true },
  { name: "laptop compact (1024×768)", width: 1024, height: 768, hasTouch: false },
  { name: "laptop regression (1220×900)", width: 1220, height: 900, hasTouch: false },
  { name: "laptop wide (1280×900)", width: 1280, height: 900, hasTouch: false },
  { name: "desktop (1440×900)", width: 1440, height: 900, hasTouch: false },
];

const SIGNED_IN_HEADER_VIEWPORTS = [
  { name: "mobile minimum", width: 320, height: 720 },
  { name: "mobile standard", width: 375, height: 812 },
  { name: "mobile", width: 390, height: 844 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "breakpoint edge", width: 900, height: 800 },
  { name: "compact laptop", width: 1024, height: 768 },
  { name: "laptop", width: 1280, height: 900 },
  { name: "desktop", width: 1440, height: 900 },
] as const;

const ADVANCED_FILTER_QUERY =
  "ecosystem=Ethereum&category=infrastructure&organization=responsive-layout-probe&minAward=1000&maxAward=100000&deadlineAfter=2026-01-01&deadlineBefore=2026-12-31&sort=postedAt%3Adesc";

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
  expect(
    box?.width ?? 0,
    `${label}: bounding box width (${box?.width}) must be at least ${MIN_TOUCH_TARGET_PX}px`,
  ).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
}

async function readBox(locator: Locator, label: string) {
  await expect(locator, `${label} must be visible`).toBeVisible();
  const box = await locator.boundingBox();
  expect(box, `${label}: could not read a bounding box`).not.toBeNull();
  if (!box) throw new Error(`${label}: could not read a bounding box`);
  return box;
}

function expectAligned(a: number, b: number, label: string): void {
  expect(Math.abs(a - b), `${label}: positions ${a} and ${b} must align`).toBeLessThanOrEqual(2);
}

/**
 * Prove composition, not just containment: coherent named groups, useful control widths, paired
 * endpoints and deliberate row changes at the laptop/tablet/phone breakpoints.
 */
async function expectAdvancedFilterComposition(page: Page, viewport: Viewport): Promise<void> {
  const details = await readBox(page.locator(".filters-group-details"), "Listing details group");
  const sort = await readBox(page.locator(".filters-group-sort"), "Sort results group");
  const award = await readBox(page.locator(".filters-group-award"), "Award range group");
  const deadline = await readBox(page.locator(".filters-group-deadline"), "Deadline range group");

  const controls = new Map<string, Awaited<ReturnType<typeof readBox>>>();
  for (const id of [
    "directory-ecosystem",
    "directory-category",
    "directory-organization",
    "directory-order",
    "directory-min-award",
    "directory-max-award",
    "directory-deadline-after",
    "directory-deadline-before",
  ]) {
    const control = page.locator(`#${id}`);
    const box = await readBox(control, id);
    expect(box.width, `${viewport.name}: ${id} must remain a useful width`).toBeGreaterThanOrEqual(
      200,
    );
    if (viewport.hasTouch) await expectTouchTarget(control, `${viewport.name}: ${id}`);
    controls.set(id, box);
  }

  const control = (id: string) => {
    const box = controls.get(id);
    if (!box) throw new Error(`${id}: control box was not recorded`);
    return box;
  };

  if (viewport.width > 896) {
    // Wide screens use a 9/3 top row and two balanced range groups below it.
    expectAligned(details.y, sort.y, `${viewport.name}: top filter groups`);
    expect(
      details.width,
      `${viewport.name}: listing details should own the wider top region`,
    ).toBeGreaterThan(sort.width * 2.5);
    expectAligned(award.y, deadline.y, `${viewport.name}: range groups`);
    expectAligned(award.width, deadline.width, `${viewport.name}: balanced range widths`);
    expect(award.y, `${viewport.name}: range row must follow the top groups`).toBeGreaterThan(
      details.y,
    );
    expect(
      Math.max(award.y + award.height, deadline.y + deadline.height) - details.y,
      `${viewport.name}: advanced filters must stay intentionally dense`,
    ).toBeLessThanOrEqual(360);
  } else {
    // Tablet and phone read the four concepts as one unambiguous vertical sequence.
    expectAligned(details.x, sort.x, `${viewport.name}: group left edges`);
    expectAligned(details.x, award.x, `${viewport.name}: group left edges`);
    expectAligned(details.x, deadline.x, `${viewport.name}: group left edges`);
    expectAligned(details.width, sort.width, `${viewport.name}: group widths`);
    expectAligned(details.width, award.width, `${viewport.name}: group widths`);
    expectAligned(details.width, deadline.width, `${viewport.name}: group widths`);
    expect(sort.y).toBeGreaterThan(details.y);
    expect(award.y).toBeGreaterThan(sort.y);
    expect(deadline.y).toBeGreaterThan(award.y);
  }

  if (viewport.width > 640) {
    expectAligned(
      control("directory-ecosystem").y,
      control("directory-category").y,
      `${viewport.name}: listing detail controls`,
    );
    expectAligned(
      control("directory-category").y,
      control("directory-organization").y,
      `${viewport.name}: listing detail controls`,
    );
    expectAligned(
      control("directory-min-award").y,
      control("directory-max-award").y,
      `${viewport.name}: award endpoints`,
    );
    expectAligned(
      control("directory-deadline-after").y,
      control("directory-deadline-before").y,
      `${viewport.name}: deadline endpoints`,
    );
  } else {
    // A phone stacks fields within each group instead of preserving cramped desktop columns.
    expect(control("directory-category").y).toBeGreaterThan(control("directory-ecosystem").y);
    expect(control("directory-organization").y).toBeGreaterThan(control("directory-category").y);
    expect(control("directory-max-award").y).toBeGreaterThan(control("directory-min-award").y);
    expect(control("directory-deadline-before").y).toBeGreaterThan(
      control("directory-deadline-after").y,
    );
  }
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

  test("the More filters disclosure remains keyboard-operable", async ({ browser, stack }) => {
    const { context, page } = await newViewportPage(browser, {
      name: "keyboard desktop",
      width: 1220,
      height: 900,
      hasTouch: false,
    });

    try {
      await page.goto(stack.urls.frontend);
      const disclosure = page.locator(".filters-more");
      const summary = page.locator(".filters-more > summary");
      await expect(summary).toBeVisible();
      await expect(disclosure).not.toHaveAttribute("open", "");

      await summary.focus();
      await page.keyboard.press("Enter");
      await expect(disclosure).toHaveAttribute("open", "");
      await page.keyboard.press("Tab");
      await expect(page.locator("#directory-ecosystem")).toBeFocused();
    } finally {
      await context.close();
    }
  });

  test("the signed-in header keeps a stable hierarchy across supported widths", async ({
    page,
    stack,
  }) => {
    skipUnlessBrowserSession(stack, "publisher");
    await page.goto(`${stack.urls.frontend}/dashboard`);

    const menu = page.getByRole("button", { name: /navigation menu/i });
    await expect(menu).toBeVisible();

    for (const viewport of SIGNED_IN_HEADER_VIEWPORTS) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await expect(menu).toHaveAttribute("aria-expanded", "false");

      const header = page.getByRole("banner");
      const main = page.getByRole("main");
      const headerBefore = await readBox(header, `${viewport.name}: closed header`);
      const mainBefore = await readBox(main, `${viewport.name}: page content`);
      expect(
        headerBefore.height,
        `${viewport.name}: the signed-in header must remain a single compact row`,
      ).toBeLessThanOrEqual(72);
      await expectTouchTarget(page.locator(".brand"), `${viewport.name}: home link`);
      await expectTouchTarget(menu, `${viewport.name}: navigation disclosure`);
      const notifications = page.getByRole("link", { name: /^Notifications/ });
      await expectTouchTarget(notifications, `${viewport.name}: notifications`);

      const primary = page.locator(".shell-nav-primary");
      if (viewport.width > 896) {
        await expect(primary).toBeVisible();
        await expect(primary.getByRole("link")).toHaveText([
          "Directory",
          "Publishers",
          "Dashboard",
        ]);
      } else {
        await expect(primary).toBeHidden();
      }

      await menu.click();
      await expect(menu).toHaveAttribute("aria-expanded", "true");
      const panel = page.locator("#account-navigation");
      await expect(panel).toBeVisible();

      const headerAfter = await readBox(header, `${viewport.name}: open header`);
      const mainAfter = await readBox(main, `${viewport.name}: content below open header`);
      expectAligned(headerBefore.height, headerAfter.height, `${viewport.name}: header height`);
      expectAligned(mainBefore.y, mainAfter.y, `${viewport.name}: content must not jump`);
      await expectNoHorizontalOverflow(page, `${viewport.name}: signed-in header`);

      for (const link of await panel.locator("a:visible").all()) {
        await expectTouchTarget(
          link,
          `${viewport.name}: ${await link.textContent()} navigation link`,
        );
      }

      const myWork = await readBox(
        panel.getByRole("heading", { name: "My work" }),
        `${viewport.name}: My work group`,
      );
      const account = await readBox(
        panel.getByRole("heading", { name: "Account" }),
        `${viewport.name}: Account group`,
      );

      if (viewport.width > 896) {
        await expect(panel.getByRole("heading", { name: "Browse" })).toBeHidden();
        await expect(panel.getByRole("heading", { name: "Help" })).toBeVisible();
        expectAligned(myWork.y, account.y, `${viewport.name}: desktop menu columns`);
        expect(account.x).toBeGreaterThan(myWork.x);
      } else {
        const browse = panel.getByRole("heading", { name: "Browse" });
        await expect(browse).toBeVisible();
        await expect(panel.getByRole("heading", { name: "Help" })).toBeHidden();
        if (viewport.width > 640) {
          expectAligned(myWork.y, account.y, `${viewport.name}: tablet menu columns`);
          expect(account.x).toBeGreaterThan(myWork.x);
          const browseLinks = panel.locator(".shell-nav-section-compact").getByRole("link");
          const browseY = await Promise.all(
            (await browseLinks.all()).map(async (link) =>
              Math.round((await readBox(link, `${viewport.name}: browse link`)).y),
            ),
          );
          expect(new Set(browseY).size).toBe(1);
        } else {
          expectAligned(myWork.x, account.x, `${viewport.name}: phone menu left edge`);
          expect(account.y).toBeGreaterThan(myWork.y);
        }
      }

      await page.keyboard.press("Escape");
      await expect(menu).toBeFocused();
      await expect(panel).toBeHidden();
    }
  });

  for (const viewport of ADVANCED_FILTER_VIEWPORTS) {
    test(`${viewport.name} — advanced filters keep their composition`, async ({
      browser,
      stack,
    }) => {
      const { context, page } = await newViewportPage(browser, viewport);

      try {
        await page.goto(`${stack.urls.frontend}/?${ADVANCED_FILTER_QUERY}`);
        await expect(page.getByRole("heading", { name: "Funding opportunities" })).toBeVisible();
        await expect(page.locator(".filters-more")).toHaveAttribute("open", "");
        await expect(page.locator(".filters-more-summary")).toHaveText("8 set");
        await expect(page.getByRole("link", { name: "Clear filters" })).toHaveAttribute(
          "href",
          "/",
        );
        await expectAdvancedFilterComposition(page, viewport);
        await expectNoHorizontalOverflow(page, `${viewport.name}: expanded directory filters`);
      } finally {
        await context.close();
      }
    });
  }

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
