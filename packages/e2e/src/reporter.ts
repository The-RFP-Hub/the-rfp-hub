/**
 * A machine-readable run summary, written through the shared redactor.
 *
 * Playwright's own reporters are kept (a `list` for the console, an `html` one for browsing a
 * failure), and this one exists for the thing neither provides: a JSON document that distinguishes
 * a criterion that PASSED from one that was BLOCKED by missing external configuration, and that
 * carries the reason and the unblocking variable for every skip.
 *
 * That distinction is the whole point of the file. A suite whose report says "37 passed, 12
 * skipped" has told the reader nothing about whether the milestone is established; one that says
 * "12 skipped, each naming the environment variable that would run it" has.
 *
 * Everything written here goes through `redact()`, and the reason strings specs produce are
 * deliberately about configuration rather than about credentials — but the redaction is applied
 * anyway, because a failure message can contain anything a spec printed.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestResult,
} from "@playwright/test/reporter";
import { redact } from "./redact.js";
import { readState } from "./state.js";

interface RecordedTest {
  project: string;
  file: string;
  title: string;
  status: "passed" | "failed" | "timedOut" | "skipped" | "interrupted";
  /** Present for a skip: the reason a spec gave, which names the unblocking variable. */
  reason?: string;
  /** True when the skip reason declares missing external configuration rather than a choice. */
  blockedByConfig: boolean;
  durationMs: number;
  errors: string[];
}

/**
 * Where the machine-readable summary goes, relative to the PACKAGE directory.
 *
 * Resolved from this module's own location rather than from `FullConfig.rootDir`. Playwright derives
 * `rootDir` from the common ancestor of the configured test directories, which for this package is
 * `packages/e2e/tests` — so a path joined onto it landed the report in `packages/e2e/tests/test-results/`,
 * which is neither the directory `.gitignore` covers nor the one the end-of-run secret scan walks. A
 * report that escapes the scanner is precisely the file most worth scanning.
 */
const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = join(packageDir, "test-results", "m3-e2e.json");
const BLOCKED_MARKER = "BLOCKED-by-missing-external-config";

export default class M3Reporter implements Reporter {
  private readonly tests: RecordedTest[] = [];
  private rootDir = process.cwd();
  private startedAt = Date.now();

  onBegin(config: FullConfig, _suite: Suite): void {
    this.rootDir = config.rootDir;
    this.startedAt = Date.now();
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    // A Playwright skip carries its reason in the annotations, not on the result, so both are read
    // and the annotation wins — that is where `test.skip(condition, reason)` puts it.
    const annotation = test.annotations.find(
      (entry) => entry.type === "skip" || entry.type === "fixme",
    );
    const reason = annotation?.description;

    this.tests.push({
      project: test.parent.project()?.name ?? "(none)",
      file: test.location.file.replace(`${this.rootDir}/`, ""),
      title: test.titlePath().filter(Boolean).join(" › "),
      status: result.status,
      reason,
      blockedByConfig: Boolean(reason?.includes(BLOCKED_MARKER)),
      durationMs: result.duration,
      errors: result.errors.map((error) => error.message ?? String(error)).slice(0, 5),
    });
  }

  onEnd(result: FullResult): void {
    let stack: ReturnType<typeof readState> | undefined;
    try {
      stack = readState();
    } catch {
      // The reporter must still produce a report when the state file is unreadable — that IS the
      // failure worth reporting, and throwing here would replace it with a reporter crash.
    }

    const blocked = this.tests.filter((entry) => entry.blockedByConfig);
    const summary = {
      runId: stack?.runId ?? "(unknown)",
      ladderLevel: stack?.level ?? "(unknown)",
      startedAt: new Date(this.startedAt).toISOString(),
      finishedAt: new Date().toISOString(),
      overallStatus: result.status,
      counts: {
        total: this.tests.length,
        passed: this.tests.filter((entry) => entry.status === "passed").length,
        failed: this.tests.filter(
          (entry) => entry.status === "failed" || entry.status === "timedOut",
        ).length,
        skipped: this.tests.filter((entry) => entry.status === "skipped").length,
        blockedByMissingConfig: blocked.length,
      },
      // The runner's own findings about what this level could not reach, carried through so one
      // document answers "what was proven" without a second lookup.
      declaredBlocked: stack?.blocked ?? [],
      declaredConditional: stack?.conditional ?? [],
      preflight: stack?.preflight,
      tests: this.tests,
    };

    const path = OUTPUT;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${redact(JSON.stringify(summary, null, 2))}\n`, { mode: 0o600 });

    if (blocked.length > 0) {
      process.stdout.write(
        `\n${blocked.length} criterion/criteria BLOCKED by missing external configuration:\n${blocked
          .map((entry) => `  • ${entry.title}\n    ${redact(entry.reason ?? "")}`)
          .join("\n")}\n`,
      );
    }
  }
}
