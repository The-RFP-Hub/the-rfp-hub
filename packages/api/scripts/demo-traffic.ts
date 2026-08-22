#!/usr/bin/env node
/**
 * Generate real HTTP traffic against a running deployment, so a publisher dashboard has something
 * to render.
 *
 * WHY THIS EXISTS AS A SEPARATE TOOL. Analytics capture is server-side and unforgeable relative to
 * the API — there is no public beacon, deliberately, because an unauthenticated event endpoint lets
 * anyone fabricate a publisher's numbers. The consequence is that you cannot seed a demo chart by
 * inserting rows: the only way to make the numbers exist is to *make the requests*. So this makes
 * them, over real HTTP, against the same public routes a reader would hit.
 *
 * IT IS NOT A LOAD TEST. It is a demo and acceptance aid: a few dozen requests, paced, shaped so
 * the resulting chart looks like something rather than a flat line.
 *
 * THREE THINGS IT HAS TO GET RIGHT, each of which is a rule the API enforces:
 *
 *   1. **A countable user-agent.** The API excludes its own automation by name
 *      (`rfphub-exporter`, `rfphub-m2-compliance`, `rfphub-m3-compliance`) and sweeps for obvious
 *      crawlers — `bot`, `curl/`, `python-requests`, `headless`, `monitor`… A request carrying any
 *      of those records nothing, and this tool would silently do nothing at all.
 *   2. **Distinct sessions.** `session_hash` is an HMAC over ip‖ua‖utc-date, so from one machine
 *      the only axis that varies is the agent string. Each simulated visitor gets its own, which is
 *      what makes "unique-ish sessions" mean anything in the resulting numbers.
 *   3. **Only today.** The event's `occurred_at` is the server's clock; nothing here can backdate
 *      one, and nothing should be able to. A multi-day chart is made by running this on multiple
 *      days, not by asking for a range.
 *
 * Usage:
 *   pnpm --filter @the-rfp-hub/api tsx scripts/demo-traffic.ts \
 *     --base-url http://localhost:3001 --namespace my-org
 *
 * It is READ-ONLY against the API: list reads, detail reads and link-out clicks. It never submits,
 * never authenticates, and needs no credential.
 */

interface Options {
  baseUrl: string;
  namespace?: string;
  ids: string[];
  sessions: number;
  readsPerSession: number;
  clickRate: number;
  pauseMs: number;
  dryRun: boolean;
  help: boolean;
}

const USAGE = `RFP Hub demo traffic generator

  tsx scripts/demo-traffic.ts --base-url <url> [--namespace <slug> | --id <public-id> ...]

Options
  --base-url <url>     The running API. Required.
  --namespace <slug>   Generate traffic for this publisher's public entries.
  --id <public-id>     A specific entry. Repeatable. Overrides --namespace.
  --sessions <n>       Distinct simulated visitors. Default 8.
  --reads <n>          Detail reads per visitor. Default 4.
  --click-rate <0-1>   Share of detail reads followed by a link-out click. Default 0.35.
  --pause <ms>         Pause between requests. Default 120.
  --dry-run            Print the plan and make no requests.
  -h, --help           This text.

Only TODAY's numbers can be produced: the event timestamp is the server's clock. Run it on several
days to fill a chart. Nothing here writes to the API — it reads public routes, the way a reader
would, which is the only way analytics can be made to exist.
`;

const DEFAULTS: Options = {
  baseUrl: "",
  ids: [],
  sessions: 8,
  readsPerSession: 4,
  clickRate: 0.35,
  pauseMs: 120,
  dryRun: false,
  help: false,
};

function parseArgs(argv: string[]): Options {
  const opts: Options = { ...DEFAULTS, ids: [] };
  const number = (raw: string | undefined, flag: string): number => {
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`${flag} must be a non-negative number, got ${JSON.stringify(raw)}`);
    }
    return value;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    const next = (): string => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      return value;
    };
    switch (arg) {
      case "-h":
      case "--help":
        opts.help = true;
        break;
      case "--base-url":
        opts.baseUrl = next().replace(/\/+$/, "");
        break;
      case "--namespace":
        opts.namespace = next();
        break;
      case "--id":
        opts.ids.push(next());
        break;
      case "--sessions":
        opts.sessions = number(next(), arg);
        break;
      case "--reads":
        opts.readsPerSession = number(next(), arg);
        break;
      case "--click-rate":
        opts.clickRate = Math.min(1, number(next(), arg));
        break;
      case "--pause":
        opts.pauseMs = number(next(), arg);
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      default:
        throw new Error(`unknown argument ${JSON.stringify(arg)} (try --help)`);
    }
  }
  return opts;
}

/**
 * One visitor's agent string.
 *
 * Deliberately honest about what it is — this is a demo aid, not a disguise — while avoiding every
 * token the API's bot pattern matches. `Mozilla/5.0` is the compatibility prefix essentially every
 * agent carries; the varying suffix is what gives each simulated visitor its own `session_hash`.
 */
function agentFor(session: number): string {
  const platforms = [
    "Macintosh; Intel Mac OS X 10_15_7",
    "Windows NT 10.0; Win64; x64",
    "X11; Linux x86_64",
    "iPhone; CPU iPhone OS 17_0 like Mac OS X",
  ];
  const platform = platforms[session % platforms.length];
  return `Mozilla/5.0 (${platform}) rfphub-demo-visitor/${session + 1}`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A deterministic, front-weighted pick.
 *
 * Real attention is not uniform: a handful of listings get most of the reads. Squaring a uniform
 * random skews towards the front of the list, which makes the resulting chart look like a chart
 * instead of a flat line — the whole point of a demo aid.
 */
function weightedIndex(length: number): number {
  return Math.min(length - 1, Math.floor(Math.random() ** 2 * length));
}

interface Entry {
  id: string;
  title: string;
  applicationUrl?: string;
}

async function resolveEntries(opts: Options): Promise<Entry[]> {
  if (opts.ids.length > 0) return opts.ids.map((id) => ({ id, title: id }));
  const params = new URLSearchParams({ limit: "25" });
  if (opts.namespace) params.set("organization", opts.namespace);
  const response = await fetch(`${opts.baseUrl}/v1/opportunities?${params}`, {
    headers: { accept: "application/json", "user-agent": agentFor(0) },
  });
  if (!response.ok) {
    throw new Error(`could not list opportunities: HTTP ${response.status}`);
  }
  const payload = (await response.json()) as { items?: Entry[] };
  return payload.items ?? [];
}

async function main(): Promise<number> {
  let opts: Options;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (opts.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (!opts.baseUrl) {
    process.stderr.write(`--base-url is required\n\n${USAGE}`);
    return 2;
  }

  const entries = await resolveEntries(opts);
  if (entries.length === 0) {
    process.stderr.write(
      `no public entries found${opts.namespace ? ` for "${opts.namespace}"` : ""}. Only APPROVED and LISTED entries have public routes to read, so a pending submission cannot accrue traffic.\n`,
    );
    return 1;
  }

  const planned = opts.sessions * (1 + opts.readsPerSession);
  process.stdout.write(
    `${entries.length} entr${entries.length === 1 ? "y" : "ies"}, ${opts.sessions} visitors × ${opts.readsPerSession} reads ≈ ${planned} requests\n`,
  );
  if (opts.dryRun) {
    for (const entry of entries) process.stdout.write(`  ${entry.id}  ${entry.title}\n`);
    return 0;
  }

  const counts = { listViews: 0, detailViews: 0, applyClicks: 0, failed: 0 };

  for (let session = 0; session < opts.sessions; session++) {
    const agent = agentFor(session);
    const headers = { accept: "application/json", "user-agent": agent };

    // A visitor lands on the list first, which is what makes `listViews` non-zero for every entry
    // on the page — the same thing a reader browsing does.
    const list = await fetch(
      `${opts.baseUrl}/v1/opportunities?limit=25${opts.namespace ? `&organization=${encodeURIComponent(opts.namespace)}` : ""}`,
      { headers },
    );
    list.ok ? counts.listViews++ : counts.failed++;
    await list.text();
    await sleep(opts.pauseMs);

    for (let read = 0; read < opts.readsPerSession; read++) {
      const entry = entries[weightedIndex(entries.length)] as Entry;
      const detail = await fetch(
        `${opts.baseUrl}/v1/opportunities/${encodeURIComponent(entry.id)}`,
        {
          headers,
        },
      );
      detail.ok ? counts.detailViews++ : counts.failed++;
      await detail.text();
      await sleep(opts.pauseMs);

      if (Math.random() < opts.clickRate) {
        // `redirect: "manual"` because the point is the 302 the API serves, not the destination
        // site: following it would fetch somebody else's page for no reason and slow this down.
        const click = await fetch(`${opts.baseUrl}/v1/r/${encodeURIComponent(entry.id)}/apply`, {
          headers,
          redirect: "manual",
        });
        click.status === 302 ? counts.applyClicks++ : counts.failed++;
        await sleep(opts.pauseMs);
      }
    }
  }

  process.stdout.write(
    `done — ${counts.listViews} list reads, ${counts.detailViews} detail reads, ${counts.applyClicks} link-out clicks, ${counts.failed} failed\n`,
  );
  process.stdout.write(
    "Capture is buffered in memory and flushed on a timer, so give it a couple of seconds before reading /v1/insights. The numbers are best-effort by design.\n",
  );
  return counts.failed === 0 ? 0 : 1;
}

process.exitCode = await main();
