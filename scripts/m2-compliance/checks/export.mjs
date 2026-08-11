/**
 * Criterion 4 — the open-data export.
 *
 * `latest.json` and `latest.csv` download and parse, the JSON envelope is CC0-marked and validates
 * against the Standard, its embedded `generatedAt` is inside the freshness window, a CC0 LICENSE
 * sits at the export root, and — the part that is easy to forget — the two aliases describe the
 * SAME RUN.
 *
 * That last one is the whole reason both files exist. A consumer who reads `latest.json` and
 * `latest.csv` and gets two different runs has a mismatched dataset with nothing to signal it, and
 * because the aliases move, neither file says on its face which run it belongs to. So the pair is
 * checked the way it is observable from outside: the CSV's data rows and the JSON's `count` and id
 * set must be the same dataset, cell for cell on a sample. Where the export publishes digest-named
 * per-run archives beside the aliases, the alias bytes are hashed and the matching archive is
 * probed — direct evidence of which run each alias is on, reported when it is available and never
 * required, because archive addressing is a property of the deployment's layout.
 */
import { createHash } from "node:crypto";
import { parseCsv, rowsAsObjects } from "../csv.mjs";
import { url, asJson, mapLimit, request } from "../http.mjs";

const LICENSE_NAMES = ["LICENSE", "LICENSE.txt", "LICENSE.md"];
const CC0_MARKERS = [/SPDX-License-Identifier:\s*CC0-1\.0/i, /CC0\s*1\.0\s*Universal/i];

export async function checkExport(report, ctx, { standard }) {
  const c = report.criterion(
    "4",
    "Export freshness",
    `latest.json and latest.csv download, parse, describe the same run, carry a CC0 licence and are no more than ${ctx.freshnessHours}h old.`,
  );

  // ── download ─────────────────────────────────────────────────────────────────────────────
  const jsonRes = await request(url(ctx.exportUrl, "/latest.json"), { timeoutMs: ctx.timeoutMs });
  const csvRes = await request(url(ctx.exportUrl, "/latest.csv"), { timeoutMs: ctx.timeoutMs });

  if (!jsonRes.ok || jsonRes.status !== 200) {
    c.fail(
      "latest.json downloads",
      `${jsonRes.url} → ${jsonRes.ok ? jsonRes.status : jsonRes.error}`,
    );
    return c.finish();
  }
  c.pass(
    "latest.json downloads",
    `→ 200 ${jsonRes.contentType || "(no content-type)"} in ${jsonRes.elapsedMs} ms, ${jsonRes.body.length} bytes`,
  );

  if (!csvRes.ok || csvRes.status !== 200) {
    c.fail("latest.csv downloads", `${csvRes.url} → ${csvRes.ok ? csvRes.status : csvRes.error}`);
    return c.finish();
  }
  c.pass(
    "latest.csv downloads",
    `→ 200 ${csvRes.contentType || "(no content-type)"} in ${csvRes.elapsedMs} ms, ${csvRes.body.length} bytes`,
  );

  // ── parse ────────────────────────────────────────────────────────────────────────────────
  const { json: envelope, error: jsonError } = asJson(jsonRes);
  if (jsonError) {
    c.fail("latest.json parses as JSON", jsonError);
    return c.finish();
  }
  const items = envelope?.opportunities;
  if (!Array.isArray(items)) {
    c.fail("latest.json parses as JSON", "the envelope carries no `opportunities` array");
    return c.finish();
  }
  c.pass("latest.json parses as JSON", `envelope with ${items.length} opportunities`);

  let table;
  try {
    table = parseCsv(csvRes.body);
  } catch (err) {
    c.fail("latest.csv parses as CSV", err.message);
    return c.finish();
  }
  const rows = rowsAsObjects(table);
  c.expect(
    table.header.length > 0 && table.header.includes("id"),
    "latest.csv parses as CSV",
    `${table.header.length} columns (${table.header.slice(0, 6).join(", ")}…), ${rows.length} data rows`,
    `header does not carry an id column: ${table.header.join(", ") || "(empty)"}`,
  );

  // ── licence ──────────────────────────────────────────────────────────────────────────────
  c.expect(
    envelope.license === "CC0-1.0",
    "the JSON envelope declares CC0-1.0",
    `license: ${envelope.license}`,
    `license: ${JSON.stringify(envelope.license)} — the export is published as a public-domain dataset, and the envelope is where a consumer reads that`,
  );

  let licenceFound = null;
  for (const name of LICENSE_NAMES) {
    const res = await request(url(ctx.exportUrl, `/${name}`), { timeoutMs: ctx.timeoutMs });
    if (res.ok && res.status === 200 && CC0_MARKERS.some((re) => re.test(res.body))) {
      licenceFound = { name, body: res.body };
      break;
    }
  }
  c.expect(
    licenceFound !== null,
    "a CC0 rights notice sits at the export root",
    `${licenceFound?.name} carries ${firstLine(licenceFound?.body ?? "")}`,
    `none of ${LICENSE_NAMES.join(", ")} answered 200 with a CC0 marker — a bare downloaded file set is then not machine-detectable as CC0`,
  );

  // ── freshness ────────────────────────────────────────────────────────────────────────────
  const generatedAt = envelope.generatedAt;
  const stamp = generatedAt ? new Date(generatedAt) : null;
  if (!stamp || Number.isNaN(stamp.getTime())) {
    c.fail(
      "the export is fresh",
      `the envelope's generatedAt is ${JSON.stringify(generatedAt)} — without a parseable timestamp the dataset cannot be shown to be current`,
    );
  } else {
    const ageHours = (Date.now() - stamp.getTime()) / 3_600_000;
    c.expect(
      ageHours <= ctx.freshnessHours && ageHours >= -0.25,
      "the export is fresh",
      `generatedAt ${stamp.toISOString()} — ${ageHours.toFixed(1)}h old, inside the ${ctx.freshnessHours}h window`,
      ageHours < 0
        ? `generatedAt ${stamp.toISOString()} is ${Math.abs(ageHours).toFixed(1)}h in the FUTURE — the publisher's clock disagrees with this one`
        : `generatedAt ${stamp.toISOString()} — ${ageHours.toFixed(1)}h old, past the ${ctx.freshnessHours}h window`,
      { generatedAt: stamp.toISOString(), ageHours },
    );
    const lastModified = jsonRes.headers["last-modified"];
    if (lastModified) {
      c.info(
        "transport-level freshness",
        `latest.json Last-Modified: ${lastModified} (secondary signal; the envelope's own generatedAt is what is asserted)`,
      );
    }
  }

  c.info(
    "export envelope",
    `specVersion ${envelope.specVersion ?? "(none)"}, count ${envelope.count}, ${items.length} documents, ${rows.length} CSV rows`,
  );
  c.expect(
    envelope.specVersion === standard.specVersion,
    `the export declares Standard v${standard.specVersion}`,
    `specVersion: ${envelope.specVersion}`,
    `specVersion: ${JSON.stringify(envelope.specVersion)}, but documents are validated against v${standard.specVersion}`,
  );
  c.expect(
    items.length >= ctx.minTotal,
    `the export publishes at least ${ctx.minTotal} entries`,
    `${items.length} opportunities`,
    `${items.length} opportunities, below the floor of ${ctx.minTotal} — a short export replaces a good one with a worse one`,
  );

  // ── the JSON validates against the Standard ─────────────────────────────────────────────
  const sampleSize = ctx.exportSample > 0 ? Math.min(ctx.exportSample, items.length) : items.length;
  const sample = evenSample(items, sampleSize);
  const invalid = [];
  await mapLimit(sample, ctx.concurrency, async (doc) => {
    const { valid, errors } = standard.validate(doc);
    if (!valid) invalid.push(`${doc?.id ?? "(no id)"}: ${errors.slice(0, 3).join("; ")}`);
  });
  c.expect(
    invalid.length === 0,
    `the exported documents validate against Standard v${standard.specVersion}`,
    `${sample.length} of ${items.length} documents validated${sample.length < items.length ? " (evenly spaced sample)" : " (all of them)"}, 0 violations`,
    `${invalid.length} of ${sample.length} sampled documents violate the Standard:\n${invalid
      .slice(0, 5)
      .map((f) => `  - ${f}`)
      .join("\n")}`,
  );

  // ── the alias pair describes one run ────────────────────────────────────────────────────
  c.expect(
    envelope.count === items.length,
    "the JSON envelope's count matches its own payload",
    `count ${envelope.count} = ${items.length} documents`,
    `count says ${envelope.count}, the payload holds ${items.length} — the envelope was written from a different dataset than the one it carries`,
  );

  const jsonIds = new Set(items.map((o) => o?.id).filter(Boolean));
  const csvIds = new Set(rows.map((r) => r.id).filter(Boolean));
  const onlyJson = [...jsonIds].filter((id) => !csvIds.has(id));
  const onlyCsv = [...csvIds].filter((id) => !jsonIds.has(id));

  c.expect(
    rows.length === items.length,
    "latest.json and latest.csv hold the same number of records",
    `${items.length} in both`,
    `latest.json holds ${items.length}, latest.csv holds ${rows.length} — the two aliases are on different runs`,
  );
  c.expect(
    onlyJson.length === 0 && onlyCsv.length === 0,
    "latest.json and latest.csv hold the same records",
    `${jsonIds.size} ids, identical on both sides`,
    `${onlyJson.length} id(s) only in JSON (${onlyJson.slice(0, 3).join(", ")}), ${onlyCsv.length} only in CSV (${onlyCsv.slice(0, 3).join(", ")})`,
  );

  // Cell-for-cell on a sample: two runs an hour apart can carry the same ids and still disagree
  // about a status or a deadline, which an id-set comparison would call identical.
  const byId = new Map(rows.map((r) => [r.id, r]));
  const mismatches = [];
  for (const doc of evenSample(items, Math.min(25, items.length))) {
    const row = byId.get(doc.id);
    if (!row) continue;
    for (const [column, expected] of [
      ["fundingType", doc.fundingType],
      ["status", doc.status],
      ["title", doc.title],
    ]) {
      if (row[column] !== undefined && String(expected ?? "") !== row[column]) {
        mismatches.push(`${doc.id}.${column}: JSON "${expected}" vs CSV "${row[column]}"`);
      }
    }
  }
  c.expect(
    mismatches.length === 0,
    "latest.json and latest.csv agree field for field on a sample",
    "sampled records carry the same fundingType, status and title in both files",
    `the two aliases disagree about records they both contain:\n${mismatches
      .slice(0, 5)
      .map((m) => `  - ${m}`)
      .join("\n")}`,
  );

  // ── digest-named archives, when the layout publishes them ───────────────────────────────
  await probeArchives(c, ctx, { jsonBody: jsonRes.body, csvBody: csvRes.body, envelope });

  return c.finish();
}

/**
 * When the export writes per-run archives named after a prefix of the sha256 of their own bytes,
 * hashing the alias bytes names the archive the alias is on — so the two aliases can be shown to
 * be on ONE run rather than merely on datasets that look alike. Best-effort: an export root that
 * does not use that layout reports the probe as not applicable and stays green, because the
 * criterion is the invariant, not the naming scheme.
 */
async function probeArchives(c, ctx, { jsonBody, csvBody, envelope }) {
  const date = String(envelope.generatedAt ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    c.skip(
      "the aliases resolve to one run's archives",
      "the envelope carries no date to build an archive name from",
    );
    return;
  }
  const digest = (body) => createHash("sha256").update(body).digest("hex").slice(0, 12);
  const names = {
    json: `opportunities-${date}-${digest(jsonBody)}.json`,
    csv: `opportunities-${date}-${digest(csvBody)}.csv`,
  };

  const found = {};
  for (const [format, name] of Object.entries(names)) {
    const res = await request(url(ctx.exportUrl, `/${name}`), {
      method: "HEAD",
      timeoutMs: ctx.timeoutMs,
    });
    found[format] = res.ok && res.status === 200 ? name : null;
  }

  if (found.json && found.csv) {
    c.pass(
      "the aliases resolve to one run's archives",
      `latest.json is ${found.json} and latest.csv is ${found.csv} — the same date stamp, so both aliases are on one run (each archive is named after the sha256 of its own bytes, so the alias bytes name it)`,
      names,
    );
  } else if (!found.json && !found.csv) {
    c.info(
      "the aliases resolve to one run's archives",
      `this export root publishes no digest-named archives beside the aliases (looked for ${names.json}, ${names.csv}). The pair invariant is asserted above from the record sets themselves.`,
    );
  } else {
    c.warn(
      "the aliases resolve to one run's archives",
      `only ${found.json ? "latest.json" : "latest.csv"} resolves to a digest-named archive (${found.json ?? found.csv}); the other alias's bytes do not name a published archive, so one of the two may have been promoted outside a run.`,
    );
  }
}

/** N evenly spaced elements — a sample that spans the dataset instead of just its head. */
function evenSample(items, n) {
  if (n >= items.length) return items;
  const step = items.length / n;
  return Array.from({ length: n }, (_, i) => items[Math.floor(i * step)]);
}

function firstLine(text) {
  return (
    text
      .split("\n")
      .find((l) => l.trim().length > 0)
      ?.trim() ?? "(empty)"
  );
}
