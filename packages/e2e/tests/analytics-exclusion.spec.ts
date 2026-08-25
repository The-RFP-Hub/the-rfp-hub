/**
 * Traffic that must NOT be counted — the only file tagged `@bot-ua`.
 *
 * WHY THE TAG AND THE SEPARATE PROJECT EXIST. `analytics-hash.ts` excludes bot user agents from
 * every counter, and "HeadlessChrome" is on that list — which is the default user agent of a
 * headless Chromium. So the ordinary analytics criteria have to run with a real desktop agent (the
 * `chromium` project) or they would assert on counters that never move for a reason unrelated to the
 * product, and THIS file has to run with the headless one. Two projects, and a `grep`/`grepInvert`
 * pair so that every other spec does not run twice.
 *
 * The exclusions are not politeness. A publisher's numbers are the basis on which they judge a
 * programme, and a crawler that moved them would make every publisher's dashboard a measure of how
 * often search engines visited.
 */
import { expect, pollUntil, skipUnlessActor, test } from "../src/fixtures.js";

test.describe("@bot-ua traffic that must not be counted", () => {
  test.beforeEach(({ stack }) => {
    skipUnlessActor(stack, "publisher");
  });

  test("a crawler-shaped user agent moves nothing", async ({
    page,
    stack,
    api,
    opportunityFixture,
  }) => {
    const publisher = await api("publisher");
    const document = opportunityFixture(stack.namespaces.publisher, `botua-${Date.now()}`);
    const id = document.id as string;
    expect((await publisher.post("/v1/opportunities", document)).status).toBe(201);

    const read = async () => {
      const response = await publisher.get<{ totals: { detailViews: number; listViews: number } }>(
        `/v1/insights/opportunities/${encodeURIComponent(id)}`,
      );
      return response.body.totals;
    };
    const before = await read();

    // This project runs with a HeadlessChrome user agent — see playwright.config.ts.
    for (let i = 0; i < 3; i++) {
      await page.goto(`${stack.urls.api}/v1/opportunities/${encodeURIComponent(id)}`);
    }
    await page.goto(`${stack.urls.api}/v1/opportunities`);

    // A positive control first: a countable read from the same worker must move the counter, so a
    // flat line below cannot be "the buffer never flushed" or "the entry is not readable".
    const desktop = publisher
      .as(undefined)
      .withUserAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      );
    await desktop.get(`/v1/opportunities/${encodeURIComponent(id)}`);
    const after = await pollUntil(
      "an ordinary desktop read is counted",
      read,
      (totals) => totals.detailViews > before.detailViews,
    );

    // Exactly one: the three crawler reads contributed nothing.
    expect(after.detailViews - before.detailViews, "only the countable read may have counted").toBe(
      1,
    );
  });

  test("@bot-ua a do-not-track request moves nothing", async ({
    stack,
    api,
    opportunityFixture,
  }) => {
    const publisher = await api("publisher");
    const document = opportunityFixture(stack.namespaces.publisher, `dnt-${Date.now()}`);
    const id = document.id as string;
    expect((await publisher.post("/v1/opportunities", document)).status).toBe(201);

    const read = async () => {
      const response = await publisher.get<{ totals: { detailViews: number } }>(
        `/v1/insights/opportunities/${encodeURIComponent(id)}`,
      );
      return response.body.totals.detailViews;
    };
    const before = await read();

    const anonymous = publisher
      .as(undefined)
      .withUserAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      );
    for (let i = 0; i < 3; i++) {
      await anonymous.get(`/v1/opportunities/${encodeURIComponent(id)}`, { headers: { dnt: "1" } });
    }

    // A stated preference not to be counted is honoured even though the same agent WOULD be counted
    // without the header — which is what the control read proves.
    await anonymous.get(`/v1/opportunities/${encodeURIComponent(id)}`);
    const after = await pollUntil("the control read is counted", read, (views) => views > before);
    expect(after - before, "only the request without `DNT: 1` may have counted").toBe(1);
  });
});
