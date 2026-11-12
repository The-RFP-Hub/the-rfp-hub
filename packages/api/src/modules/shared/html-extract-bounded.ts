/**
 * `extractPage`, off the event loop and against a deadline.
 *
 * The extractor is linear now (`html-extract.ts`), and this is the second wall rather than the
 * first: the page is a stranger's bytes, the API serves everyone from one event loop, and
 * "linear" is a property of the code as it stands — the next regex added to it, or a pathological
 * shape nobody thought of, would put the API back at the mercy of whoever controls a submitted
 * URL. So each extraction runs in its own worker thread, and a worker that has not answered by the
 * deadline is terminated and the extraction reported as INTERRUPTED. The caller records that as
 * what happened (`verification.service.ts`), never as a page that said nothing.
 *
 * ONE WORKER PER PAGE, not a pool. A worker that hits the deadline has to be killed anyway, the
 * fetch in front of it is a network round trip that dwarfs a thread's start-up, and the submit-time
 * queue runs at most two checks at once. A pool would be reuse bought with a recycling protocol
 * nobody needs at this volume.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import type { ExtractOptions, ExtractedPage } from "./html-extract.js";

export type BoundedExtraction =
  | { ok: true; page: ExtractedPage }
  | {
      ok: false;
      /**
       * `interrupted`: the PAGE did it — the deadline passed, or the worker ran out of heap. A fact
       * about these bytes, recorded as a verdict.
       *
       * `unavailable`: the WORKER did it — it could not be started, its code did not load, it
       * crashed or exited without answering. A fact about this process, not about the page, so the
       * caller must not let it change what is known about the entry. Telling the two apart is what
       * keeps a broken image or loader from unverifying every entry the nightly job touches.
       */
      kind: "interrupted" | "unavailable";
      /** Why the extraction did not finish, worded for the run's `error` column. */
      reason: string;
    };

export interface BoundedExtractOptions extends ExtractOptions {
  /** How long the worker may take, start-up included, before it is terminated. */
  timeoutMs: number;
}

/**
 * Where the worker's code is, and how to start it.
 *
 * Built (`node dist/server.js`, `node dist/jobs.js`): this module is bundled into an entry at the
 * root of `dist/`, and `html-extract.worker.js` is built next to it. From source (`tsx`, vitest):
 * this module is the `.ts` file beside the worker's `.ts` file, and the worker thread needs a
 * TypeScript loader, which a worker does not inherit from the process. `--import tsx` in the
 * worker's `execArgv` is NOT enough on Node 22 (the hooks never reach the worker's own imports,
 * so `./html-extract.js` is not mapped to the `.ts` file); a tiny bootstrap that registers tsx's
 * hooks inside the thread with its API and then imports the worker works on 22 and 24 alike.
 */
function workerEntry(): URL {
  const here = import.meta.url;
  if (!here.endsWith(".ts")) return new URL("./html-extract.worker.js", here);
  const tsxRoot = dirname(createRequire(here).resolve("tsx/package.json"));
  const api = pathToFileURL(join(tsxRoot, "dist/esm/api/index.mjs")).href;
  const target = new URL("./html-extract.worker.ts", here).href;
  const bootstrap = `const { register } = await import(${JSON.stringify(api)}); register(); await import(${JSON.stringify(target)});`;
  return new URL(`data:text/javascript,${encodeURIComponent(bootstrap)}`);
}

/**
 * A ceiling on the worker's heap. A 2 MiB page needs a small fraction of it; a shape that makes the
 * extractor allocate without bound ends the worker with an out-of-memory error, which is reported
 * as an interruption like any other, instead of taking the process down with it.
 */
const WORKER_HEAP_MB = 256;

export function extractPageBounded(
  html: string,
  options: BoundedExtractOptions,
): Promise<BoundedExtraction> {
  const { timeoutMs, ...extractOptions } = options;
  const unavailable = (detail: string): BoundedExtraction => ({
    ok: false,
    kind: "unavailable",
    reason: `extraction_unavailable: ${detail}`,
  });
  let worker: Worker;
  try {
    worker = new Worker(workerEntry(), {
      workerData: { html, options: extractOptions },
      resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB },
    });
  } catch (error) {
    return Promise.resolve(
      unavailable(`the extraction worker could not be started: ${messageOf(error)}`),
    );
  }
  const started = worker;
  return new Promise((resolve) => {
    let settled = false;
    const settle = (result: BoundedExtraction): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
      // Done either way: a finished worker exits by itself, an unfinished one is stopped here.
      void started.terminate();
    };

    const timer = setTimeout(() => {
      settle({
        ok: false,
        kind: "interrupted",
        reason: `extraction_interrupted: the page was not extracted within ${timeoutMs} ms`,
      });
    }, timeoutMs);

    started.once("message", (page: ExtractedPage) => settle({ ok: true, page }));
    started.once("error", (error: Error & { code?: string }) => {
      // Running out of heap is the page's doing (`WORKER_HEAP_MB`); anything else is ours.
      if (error.code === "ERR_WORKER_OUT_OF_MEMORY") {
        settle({
          ok: false,
          kind: "interrupted",
          reason: `extraction_interrupted: the page needed more than ${WORKER_HEAP_MB} MB to extract`,
        });
        return;
      }
      settle(unavailable(messageOf(error)));
    });
    started.once("exit", (code) => {
      settle(unavailable(`the extraction worker exited (code ${code}) without a result`));
    });
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
