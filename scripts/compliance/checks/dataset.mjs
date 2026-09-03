/**
 * Criterion 3 — the dataset.
 *
 * `/v1/stats` reports at least the floor; the list endpoint pages cleanly; and EVERY opportunity
 * the deployment serves validates against the Standard v1.0.0 JSON Schema.
 *
 * "Every document" is taken literally, and it needs both endpoints to mean anything. The list
 * endpoint serves `OpportunitySummary` — a server-controlled projection that deliberately omits
 * `fundingDetails`, which the Standard requires — so a list item is held to the projection the
 * service PUBLISHES for it, and the full document behind every listed id is then fetched from the
 * detail endpoint and validated against the Standard itself, with the repo's own validator.
 * Validating only the summaries would be validating something the Standard never describes.
 *
 * The filter-consistency checks are the arithmetic that a count from a filtered query and a count
 * from `/v1/stats` have to agree on. They are what catches a filter that silently drops its
 * predicate — the failure mode a per-endpoint 200 check cannot see.
 */
import { url, asJson, mapLimit, query, request } from "../http.mjs";

export async function checkDataset(report, ctx, { doc, bundle, standard }) {
  const c = report.criterion(
    "3",
    "Dataset",
    `/v1/stats reports at least ${ctx.minTotal} entries, the list pages consistently, every served document validates against Standard v${standard.specVersion}, and filtered counts agree with the aggregate.`,
  );

  // ── stats and the floor ──────────────────────────────────────────────────────────────────
  const statsRes = await request(url(ctx.baseUrl, "/v1/stats"), { timeoutMs: ctx.timeoutMs });
  if (!statsRes.ok || statsRes.status !== 200) {
    c.fail("GET /v1/stats answers", `→ ${statsRes.ok ? statsRes.status : statsRes.error}`);
    return c.finish();
  }
  const stats = asJson(statsRes).json;
  if (!stats || typeof stats.total !== "number") {
    c.fail("GET /v1/stats reports a total", `body: ${statsRes.body.slice(0, 200)}`);
    return c.finish();
  }
  const total = stats.total;
  c.expect(
    total >= ctx.minTotal,
    `the public dataset holds at least ${ctx.minTotal} entries`,
    `/v1/stats total = ${total}`,
    `/v1/stats total = ${total}, below the floor of ${ctx.minTotal}`,
    { total, floor: ctx.minTotal },
  );
  c.info(
    "dataset shape",
    [
      `by funding type: ${describeTally(stats.byFundingType)}`,
      `by status: ${describeTally(stats.byStatus)}`,
      `top ecosystems: ${(stats.topEcosystems ?? []).map((e) => `${e.ecosystem} ${e.count}`).join(", ") || "(none)"}`,
      `last updated: ${stats.lastUpdatedAt ?? "(never)"}`,
    ].join("\n"),
    stats,
  );

  // ── the schema the service serves is the version being validated against ────────────────
  const schemaRes = await request(url(ctx.baseUrl, "/v1/opportunities/schema"), {
    timeoutMs: ctx.timeoutMs,
  });
  let servedSchema;
  if (schemaRes.ok && schemaRes.status === 200) {
    servedSchema = asJson(schemaRes).json;
    const id = String(servedSchema?.$id ?? "");
    c.expect(
      id.includes(standard.specVersion),
      "the schema the service publishes is the Standard version documents are validated against",
      `served $id: ${id} (validating against v${standard.specVersion})`,
      `served $id: ${id || "(none)"}, but documents are validated against v${standard.specVersion} — the deployment and this checker disagree about the contract`,
    );
  } else {
    c.fail(
      "the schema the service publishes is fetchable",
      `GET /v1/opportunities/schema → ${schemaRes.ok ? schemaRes.status : schemaRes.error}`,
    );
  }

  // ── page through the whole list ──────────────────────────────────────────────────────────
  const limit = pageLimit(doc);
  const ids = [];
  const seen = new Set();
  let duplicates = 0;
  let pages = 0;
  let totalDrift = null;
  const summaryFailures = [];

  const summarySchema = bundle?.component("OpportunitySummary")
    ? { $ref: "#/components/schemas/OpportunitySummary" }
    : null;

  const expectedPages = Math.max(1, Math.ceil(total / limit));
  for (let page = 1; page <= expectedPages + 1; page++) {
    // No `sort`: paging uses whatever the published default is, which is the order a consumer
    // gets. The service breaks ties on a unique column, so the order is total and paging is stable.
    const target = url(ctx.baseUrl, "/v1/opportunities") + query({ page, limit });
    const res = await request(target, { timeoutMs: ctx.timeoutMs });
    if (!res.ok || res.status !== 200) {
      c.fail(
        "the list endpoint pages through the whole dataset",
        `page ${page} → ${res.ok ? res.status : res.error}`,
      );
      return c.finish();
    }
    const body = asJson(res).json;
    if (!body || !Array.isArray(body.items)) {
      c.fail(
        "the list endpoint pages through the whole dataset",
        `page ${page}: body has no items array`,
      );
      return c.finish();
    }
    if (body.total !== total && totalDrift === null)
      totalDrift = `page ${page} reports total ${body.total}, /v1/stats reports ${total}`;
    if (body.items.length === 0) break;
    pages++;

    for (const item of body.items) {
      if (seen.has(item.id)) duplicates++;
      else {
        seen.add(item.id);
        ids.push(item.id);
      }
      if (summarySchema && summaryFailures.length < 5) {
        const { valid, errors } = bundle.validate(summarySchema, item);
        if (!valid) summaryFailures.push(`${item.id}: ${errors.slice(0, 3).join("; ")}`);
      }
    }
    if (ids.length >= total && page >= expectedPages) break;
  }

  c.expect(
    ids.length === total,
    "the list endpoint pages through the whole dataset",
    `${ids.length} distinct ids over ${pages} pages of ${limit}, matching the reported total`,
    `paged ${ids.length} distinct ids over ${pages} pages, but the dataset reports ${total}`,
  );
  c.expect(
    duplicates === 0,
    "pagination returns each record exactly once",
    "no id appeared on two pages",
    `${duplicates} duplicate id(s) across pages — the sort is not a total order, so records can be skipped as well as repeated`,
  );
  if (totalDrift) c.fail("the reported total is stable across pages", totalDrift);
  else c.pass("the reported total is stable across pages", `every page reported total ${total}`);

  if (summarySchema) {
    c.expect(
      summaryFailures.length === 0,
      "every list item conforms to the published OpportunitySummary projection",
      `${ids.length} items validated against the component the deployment publishes`,
      `${summaryFailures.length}+ list item(s) violate the published projection:\n${summaryFailures.map((f) => `  - ${f}`).join("\n")}`,
    );
  } else {
    c.skip(
      "every list item conforms to the published OpportunitySummary projection",
      "the served OpenAPI document declares no OpportunitySummary component",
    );
  }

  // ── every served document, against the Standard ──────────────────────────────────────────
  const capped = ctx.maxDetails > 0 && ctx.maxDetails < ids.length;
  const subject = capped ? ids.slice(0, ctx.maxDetails) : ids;
  const results = await mapLimit(subject, ctx.concurrency, async (id) => {
    const res = await request(url(ctx.baseUrl, `/v1/opportunities/${encodeURIComponent(id)}`), {
      timeoutMs: ctx.timeoutMs,
    });
    if (!res.ok || res.status !== 200) {
      return { id, transport: `→ ${res.ok ? res.status : res.error}` };
    }
    const { json, error } = asJson(res);
    if (error) return { id, transport: error };
    return { id, document: json, ...standard.validate(json) };
  });

  const unreachable = results.filter((r) => r.transport);
  const invalid = results.filter((r) => !r.transport && !r.valid);
  const warned = results.filter((r) => !r.transport && (r.warnings?.length ?? 0) > 0);
  const wrongVersion = results.filter(
    (r) => r.document && r.document.specVersion !== standard.specVersion,
  );

  if (unreachable.length > 0) {
    c.fail(
      "every listed opportunity resolves at the detail endpoint",
      `${unreachable.length} of ${subject.length} did not:\n${unreachable
        .slice(0, 5)
        .map((r) => `  - ${r.id} ${r.transport}`)
        .join("\n")}`,
    );
  } else {
    c.pass(
      "every listed opportunity resolves at the detail endpoint",
      `${subject.length} documents fetched at concurrency ${ctx.concurrency}`,
    );
  }

  c.expect(
    invalid.length === 0,
    `every served document validates against Standard v${standard.specVersion}`,
    `${subject.length - unreachable.length} full documents validated with the repo's own validator, 0 schema violations`,
    `${invalid.length} document(s) violate the Standard:\n${invalid
      .slice(0, 5)
      .map((r) => `  - ${r.id}: ${r.errors.slice(0, 3).join("; ")}`)
      .join("\n")}${invalid.length > 5 ? `\n  … and ${invalid.length - 5} more` : ""}`,
  );

  c.expect(
    wrongVersion.length === 0,
    `every served document declares specVersion ${standard.specVersion}`,
    `all ${subject.length - unreachable.length} documents agree on the spec version`,
    `${wrongVersion.length} document(s) declare a different specVersion: ${wrongVersion
      .slice(0, 5)
      .map((r) => `${r.id}=${r.document.specVersion}`)
      .join(", ")}`,
  );

  if (capped) {
    c.warn(
      "the whole dataset was validated",
      `--max-details ${ctx.maxDetails} capped this run at ${subject.length} of ${ids.length} documents. A sign-off run should leave it at 0 (unlimited).`,
    );
  }
  if (warned.length > 0) {
    const sample = warned.slice(0, 3).map((r) => `  - ${r.id}: ${r.warnings[0]}`);
    c.info(
      "advisory findings from the validator's check tier",
      `${warned.length} of ${subject.length} documents raise at least one advisory warning. These are conformant documents — the warnings are vocabulary/quality signal, not violations.\n${sample.join("\n")}`,
    );
  }

  // ── filtered counts have to add up ───────────────────────────────────────────────────────
  await checkFilterConsistency(c, ctx, {
    name: "status",
    values: enumValues(servedSchema, doc, "status"),
    tally: stats.byStatus,
    total,
  });
  await checkFilterConsistency(c, ctx, {
    name: "fundingType",
    values: enumValues(servedSchema, doc, "fundingType"),
    tally: stats.byFundingType,
    total,
  });

  return c.finish();
}

/**
 * For each value of a filter, the count the filtered query reports must equal the count
 * `/v1/stats` reports for it, and the values must partition the dataset — the sum is the total.
 * A repeated/comma-separated multi-value query is checked too, since OR-ing two values is where a
 * filter that builds the wrong predicate shows up.
 */
async function checkFilterConsistency(c, ctx, { name, values, tally, total }) {
  if (!values || values.length === 0) {
    c.skip(
      `${name} filters return counts consistent with /v1/stats`,
      "no value set could be read from the published contract",
    );
    return;
  }

  const counts = await mapLimit(values, ctx.concurrency, async (value) => {
    const target = url(ctx.baseUrl, "/v1/opportunities") + query({ [name]: value, limit: 1 });
    const res = await request(target, { timeoutMs: ctx.timeoutMs });
    if (!res.ok || res.status !== 200)
      return { value, error: `→ ${res.ok ? res.status : res.error}` };
    const body = asJson(res).json;
    return { value, total: body?.total };
  });

  const broken = counts.filter((r) => r.error || typeof r.total !== "number");
  if (broken.length > 0) {
    c.fail(
      `${name} filters return counts consistent with /v1/stats`,
      broken.map((r) => `  - ${name}=${r.value} ${r.error ?? "returned no total"}`).join("\n"),
    );
    return;
  }

  const disagreements = counts.filter((r) => r.total !== (tally?.[r.value] ?? 0));
  const sum = counts.reduce((acc, r) => acc + r.total, 0);

  c.expect(
    disagreements.length === 0,
    `${name} filters return counts consistent with /v1/stats`,
    counts.map((r) => `${r.value}=${r.total}`).join(", "),
    `filtered count disagrees with /v1/stats:\n${disagreements
      .map(
        (r) =>
          `  - ${name}=${r.value}: filter says ${r.total}, /v1/stats says ${tally?.[r.value] ?? 0}`,
      )
      .join("\n")}`,
  );
  c.expect(
    sum === total,
    `the ${name} values partition the dataset`,
    `${counts.map((r) => r.total).join(" + ")} = ${sum}, the reported total`,
    `the per-value counts sum to ${sum}, but the dataset reports ${total} — records are being double-counted or missed`,
  );

  // OR-ing two values must be the sum of the two, not the whole dataset (which is what a dropped
  // predicate looks like) and not one of them (which is what a last-value-wins parser looks like).
  if (values.length >= 2) {
    const [a, b] = values;
    const target = url(ctx.baseUrl, "/v1/opportunities") + query({ [name]: `${a},${b}`, limit: 1 });
    const res = await request(target, { timeoutMs: ctx.timeoutMs });
    const body = res.ok && res.status === 200 ? asJson(res).json : null;
    const expected = (tally?.[a] ?? 0) + (tally?.[b] ?? 0);
    c.expect(
      body?.total === expected,
      `a comma-separated ${name} filter ORs its values`,
      `${name}=${a},${b} → ${expected}`,
      `${name}=${a},${b} → ${body?.total ?? (res.ok ? res.status : res.error)}, expected ${expected}`,
    );
  }
}

/** The accepted values of a field, read from the served schema first, then the OpenAPI document. */
function enumValues(servedSchema, doc, field) {
  const fromSchema = servedSchema?.properties?.[field]?.enum;
  if (Array.isArray(fromSchema)) return fromSchema;
  const fromDoc = doc?.components?.schemas?.Opportunity?.properties?.[field]?.enum;
  return Array.isArray(fromDoc) ? fromDoc : null;
}

/** The largest page size the published contract allows, so paging uses as few requests as it can. */
function pageLimit(doc) {
  const param = (doc?.paths?.["/v1/opportunities"]?.get?.parameters ?? []).find(
    (p) => p?.name === "limit",
  );
  const max = param?.schema?.maximum;
  return Number.isInteger(max) && max > 0 ? max : 100;
}

function describeTally(tally) {
  const entries = Object.entries(tally ?? {});
  return entries.length === 0 ? "(none)" : entries.map(([k, v]) => `${k} ${v}`).join(", ");
}
