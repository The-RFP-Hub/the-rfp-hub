/**
 * The worker side of `extractPageBounded` (`html-extract-bounded.ts`): extract one page and post
 * the result back. One worker per page, so a page that runs past its deadline is ended by
 * terminating this thread, never by hoping the extraction yields.
 *
 * Built as its own entry point (`tsup.config.ts`) so it sits next to `server.js` and `jobs.js` in
 * `dist/`, which is where the bounded extractor looks for it.
 */
import { parentPort, workerData } from "node:worker_threads";
import { type ExtractOptions, extractPage } from "./html-extract.js";

const { html, options } = workerData as { html: string; options: ExtractOptions };
parentPort?.postMessage(extractPage(html, options));
