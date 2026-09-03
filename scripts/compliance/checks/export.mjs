/**
 * Criterion 4 — the open-data export.
 *
 * `latest.json` and `latest.csv` download and parse, the JSON envelope is CC0-marked and validates
 * against the Standard, its embedded `generatedAt` is inside the freshness window, a CC0 LICENSE
 * sits at the export root, and — the part that is easy to forget — the two aliases describe the
 * same DATASET, and where the export publishes a manifest, the same RUN.
 *
 * Those are two different assertions and the difference is the whole subtlety of this criterion.
 *
 * The DATASET half is checked the way it is observable from outside: the CSV's data rows and the
 * JSON's `count` and id set must be the same dataset, cell for cell on a sample. That catches the
 * failure a consumer actually feels — reading both files and getting different data — but it does
 * not establish run identity. Two different runs carrying the same records are indistinguishable
 * to it, and a checker cannot manufacture an identity the publisher never wrote.
 *
 * The RUN half needs the publisher to say something. `latest.manifest.json` is that: one run id,
 * and the immutable href plus full sha256 of each artifact, replaced by a single atomic operation
 * so a consumer never reads it half-updated. Resolved once, it makes "these two artifacts are one
 * run's" a fact this checker can VERIFY — hash the bytes, compare to the recorded digests — rather
 * than infer. Where no manifest is published the criterion says exactly what it therefore cannot
 * establish, and falls back to the weaker digest-named-archive probe, which rules out a cross-day
 * mixed pair and nothing finer.
 */
import { createHash } from "node:crypto";
import { parseCsv, rowsAsObjects } from "../csv.mjs";
import { url, asJson, mapLimit, request } from "../http.mjs";

const LICENSE_NAMES = ["LICENSE", "LICENSE.txt", "LICENSE.md"];
const CC0_MARKERS = [/SPDX-License-Identifier:\s*CC0-1\.0/i, /CC0\s*1\.0\s*Universal/i];
const MANIFEST_NAME = "latest.manifest.json";

const sha256 = (body) => createHash("sha256").update(body).digest("hex");

export async function checkExport(report, ctx, { standard }) {
  const c = report.criterion(
    "export",
    "Export freshness",
    `latest.json and latest.csv download, parse, describe the same dataset (and, where a manifest is published, the same verified run), carry a CC0 licence and are no more than ${ctx.freshnessHours}h old.`,
  );

  // ── download ─────────────────────────────────────────────────────────────────────────────
  // Every fetch in this criterion opts INTO following redirects (`follow: true`). The published
  // artifacts are served by a static file host, where a redirect is ordinary plumbing — and the
  // question here is what a consumer ends up downloading, not which hop served it. The API's own
  // operations are the opposite case and are checked unfollowed; see `request` in ../http.mjs.
  const jsonRes = await request(url(ctx.exportUrl, "/latest.json"), {
    timeoutMs: ctx.timeoutMs,
    follow: true,
  });
  const csvRes = await request(url(ctx.exportUrl, "/latest.csv"), {
    timeoutMs: ctx.timeoutMs,
    follow: true,
  });

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
    const res = await request(url(ctx.exportUrl, `/${name}`), {
      timeoutMs: ctx.timeoutMs,
      follow: true,
    });
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

  // ── run identity, from the manifest the publisher writes ────────────────────────────────
  await probeManifest(c, ctx, { jsonBody: jsonRes.body, csvBody: csvRes.body, envelope });

  return c.finish();
}

/**
 * The same-run proof, consumed the way a consumer is meant to consume it.
 *
 * `latest.manifest.json` is the export's single mutable pointer: it names each artifact by an
 * IMMUTABLE href and carries the full sha256 of its bytes, and it is replaced by one atomic
 * operation, so it is never observed half-updated. That combination is what turns "these two files
 * are one run's" from an inference into a verification — resolve the pointer once, then hash what
 * you hold and compare.
 *
 * So this does three things, in order of what they establish:
 *
 *   1. the pointer is well-formed and really is a single-file pointer — one artifact per format,
 *      every href immutable and content-addressed, nothing naming a moving alias;
 *   2. every artifact the manifest names verifies against its recorded digest (bytes already in
 *      hand are used where they match, so the common case costs no extra download);
 *   3. whether the two ALIASES are on that manifest's run, which is the question the aliases
 *      cannot answer about themselves.
 *
 * Step 3 is deliberately not a hard failure when it comes out negative. The aliases and the
 * manifest are fetched in three separate requests, so a run promoting mid-check moves them under
 * the checker — an expected, benign race, and the exact window the manifest exists to let a
 * consumer avoid. What matters is that it is reported honestly rather than scored as identity.
 *
 * Where no manifest exists at all, the run says so as a named limitation and falls back to
 * `probeArchives`.
 */
async function probeManifest(c, ctx, { jsonBody, csvBody, envelope }) {
  const res = await request(url(ctx.exportUrl, `/${MANIFEST_NAME}`), {
    timeoutMs: ctx.timeoutMs,
    follow: true,
  });
  if (!res.ok || res.status !== 200) {
    c.skip(
      "the aliases are provably one run's",
      [
        `no ${MANIFEST_NAME} at the export root (${res.ok ? res.status : res.error}) — a PRE-MANIFEST DEPLOYMENT.`,
        "Run identity cannot be established here, and that is a limit of the published contract rather than of this check:",
        "neither alias carries a run identifier, so nothing served distinguishes two same-day runs that carry the same records.",
        "What is asserted above is that the two aliases describe the same DATASET; the archive probe below is all that is left of run identity.",
      ].join("\n"),
    );
    await probeArchives(c, ctx, { jsonBody, csvBody, envelope });
    return;
  }

  const { json: manifest, error } = asJson(res);
  if (error) {
    c.fail("the export manifest parses", `${MANIFEST_NAME} → ${error}`);
    return;
  }

  const artifacts = Array.isArray(manifest?.artifacts) ? manifest.artifacts : [];
  const wellFormed =
    typeof manifest?.runId === "string" &&
    manifest.runId.length > 0 &&
    artifacts.length > 0 &&
    artifacts.every(
      (a) => typeof a?.href === "string" && /^[0-9a-f]{64}$/i.test(String(a?.sha256 ?? "")),
    );
  if (!wellFormed) {
    c.fail(
      "the export manifest parses",
      `${MANIFEST_NAME} does not carry a runId and an artifacts[] of { href, sha256 } — without those it is not a pointer anything can be resolved through`,
    );
    return;
  }
  c.pass(
    "the export manifest parses",
    `runId ${manifest.runId}, generatedAt ${manifest.generatedAt ?? "(none)"}, count ${manifest.count ?? "(none)"}, ${artifacts.length} artifacts`,
  );

  // (1) A single-file pointer: one mutable name in the whole chain, and it is this one. An href
  // naming a moving alias would hand back exactly the ambiguity the manifest is there to remove.
  const byFormat = new Map();
  for (const a of artifacts) byFormat.set(a.format, (byFormat.get(a.format) ?? 0) + 1);
  const duplicated = [...byFormat].filter(([, n]) => n > 1).map(([f]) => f);
  const mutableHrefs = artifacts.map((a) => a.href).filter((href) => !isContentAddressed(href));
  c.expect(
    duplicated.length === 0 && mutableHrefs.length === 0,
    "the manifest is a single pointer at immutable artifacts",
    `${artifacts.length} artifacts (${artifacts.map((a) => a.format).join(", ")}), each named by a content-addressed href — ${MANIFEST_NAME} is the only name in the chain that moves`,
    duplicated.length > 0
      ? `the manifest lists ${duplicated.join(", ")} more than once, so "the artifact of this run" is ambiguous`
      : `the manifest points at names that can be overwritten (${mutableHrefs.join(", ")}) — resolving through it then proves nothing, because what it names can change under the consumer`,
  );

  // (2) Verify the digests. Bytes already downloaded are reused where they match, so a deployment
  // whose aliases are current costs no extra transfer for the proof.
  const aliasBytes = { json: jsonBody, csv: csvBody };
  const aliasDigest = { json: sha256(jsonBody), csv: sha256(csvBody) };
  const failures = [];
  const verified = [];
  for (const a of artifacts) {
    const recorded = String(a.sha256).toLowerCase();
    if (aliasDigest[a.format] === recorded) {
      verified.push(`${a.href} (from the ${a.format} alias's own bytes)`);
      continue;
    }
    const fetched = await request(url(ctx.exportUrl, `/${a.href}`), {
      timeoutMs: ctx.timeoutMs,
      follow: true,
    });
    if (!fetched.ok || fetched.status !== 200) {
      failures.push(
        `${a.href} → ${fetched.ok ? fetched.status : fetched.error} (the manifest names an artifact that is not served)`,
      );
      continue;
    }
    const actual = sha256(fetched.body);
    if (actual === recorded) verified.push(`${a.href} (downloaded, ${fetched.body.length} bytes)`);
    else
      failures.push(
        `${a.href}: manifest records ${recorded.slice(0, 16)}…, bytes hash to ${actual.slice(0, 16)}…`,
      );
  }
  c.expect(
    failures.length === 0,
    "every artifact the manifest names verifies against its recorded digest",
    `${verified.length} of ${artifacts.length} verified: ${verified.join("; ")} — one runId over artifacts whose bytes are confirmed is a pair that is provably one run's`,
    `${failures.length} of ${artifacts.length} did not verify:\n${failures.map((f) => `  - ${f}`).join("\n")}`,
  );

  // (3) Are the aliases themselves on that run? This is the question `latest.*` cannot answer about
  // itself, and the manifest's digests answer it exactly: identical bytes, identical hash.
  const onRun = artifacts.filter((a) => aliasDigest[a.format] === String(a.sha256).toLowerCase());
  const covered = artifacts.filter((a) => a.format in aliasBytes);
  if (onRun.length === covered.length && covered.length > 0) {
    c.pass(
      "latest.json and latest.csv are on the run the manifest names",
      `both alias byte-streams hash to the digests recorded for run ${manifest.runId} — not merely datasets that look alike, the same run`,
      { runId: manifest.runId },
    );
  } else if (onRun.length === 0) {
    c.info(
      "latest.json and latest.csv are on the run the manifest names",
      `neither alias matches run ${manifest.runId}'s recorded digests. The aliases and the manifest were fetched in separate requests, so the ordinary cause is a run that promoted between them; the manifest's own artifacts verified above, and a consumer that resolves the manifest once is unaffected either way.`,
    );
  } else {
    c.warn(
      "latest.json and latest.csv are on the run the manifest names",
      `${onRun.map((a) => `latest.${a.format}`).join(", ")} matches run ${manifest.runId} and the other alias does not. This is the alias-pair window itself: two independently named mutable files cannot be replaced as a pair, so a reader can catch one of each run. It is why the manifest is the pointer to resolve, and it is not a defect in the data — the manifest's artifacts verified above.`,
    );
  }
}

/**
 * Whether an href names something that cannot be rewritten under the consumer. A moving alias is
 * the obvious no; so is any name with no digest segment in it, because nothing then stops a later
 * run from publishing different bytes under it.
 */
function isContentAddressed(href) {
  return !href.startsWith("latest.") && /-[0-9a-f]{12}\.[a-z0-9]+$/i.test(href);
}

/**
 * The pre-manifest fallback. Each archive is named after a prefix of the sha256 of its own bytes,
 * so hashing an alias names the archive that alias is on — but the name is scoped only by the
 * envelope's DATE. So what this establishes is bounded and worth stating exactly: each alias's
 * bytes name a published archive stamped with the envelope's own date, which rules out a cross-day
 * mixed pair. It cannot distinguish two runs on the same date, and under an exporter whose CSV is
 * byte-stable across same-day reruns the CSV half cannot distinguish them even in principle.
 *
 * Reported, never required: archive addressing is a property of the deployment's layout, and the
 * criterion is the invariant rather than the naming scheme.
 */
async function probeArchives(c, ctx, { jsonBody, csvBody, envelope }) {
  const date = String(envelope.generatedAt ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    c.skip(
      "each alias's bytes name a published archive of the envelope's date",
      "the envelope carries no date to build an archive name from",
    );
    return;
  }
  const digest = (body) => sha256(body).slice(0, 12);
  const names = {
    json: `opportunities-${date}-${digest(jsonBody)}.json`,
    csv: `opportunities-${date}-${digest(csvBody)}.csv`,
  };

  const found = {};
  for (const [format, name] of Object.entries(names)) {
    const res = await request(url(ctx.exportUrl, `/${name}`), {
      method: "HEAD",
      timeoutMs: ctx.timeoutMs,
      follow: true,
    });
    found[format] = res.ok && res.status === 200 ? name : null;
  }

  if (found.json && found.csv) {
    c.pass(
      "each alias's bytes name a published archive of the envelope's date",
      `latest.json is ${found.json} and latest.csv is ${found.csv} — both alias byte-streams name published archives of the same date, which rules out a cross-day mixed pair. It does not establish one run: two same-day runs are indistinguishable here, and an unchanged CSV keeps its archive name across them.`,
      names,
    );
  } else if (!found.json && !found.csv) {
    c.info(
      "each alias's bytes name a published archive of the envelope's date",
      `this export root publishes no digest-named archives beside the aliases (looked for ${names.json}, ${names.csv}). The pair invariant is asserted above from the record sets themselves.`,
    );
  } else {
    c.warn(
      "each alias's bytes name a published archive of the envelope's date",
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

export const meta = {
  key: "export",
  requires: [],
  needs: ["api", "exportUrl", "standard"],
  contract: { m2: "M2-4" },
};

export async function run(ctx) {
  await checkExport(ctx.report, ctx, { standard: ctx.standard });
}
