/**
 * The two typefaces the generated cards draw with, read from disk once per server process.
 *
 * Vendored under `src/assets/fonts` (OFL) because `next/font` keeps its files behind hashed
 * `/_next/static` paths a route handler cannot read at runtime, and fetching from a font CDN per
 * request would send every card request to a third party. `outputFileTracingIncludes` in
 * `next.config.ts` is what puts the files into the standalone and serverless bundles.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const INK = "#1a1917";
export const PAPER = "#fcfcfa";
export const SECONDARY = "#a8a29e";

let fontsPromise: Promise<{ display: ArrayBuffer; body: ArrayBuffer }> | null = null;

/**
 * Read from disk, once per server process, from wherever the build put the package: the traced
 * standalone server `chdir`s into the package directory, a serverless bundle keeps the monorepo
 * path under its task root. `outputFileTracingIncludes` in `next.config.ts` is what guarantees
 * the two files are in either bundle at all — a bundled-URL `fetch` resolved to a `/_next/static`
 * path that a traced server cannot serve to itself.
 */
const FONT_DIRS = [
  join(process.cwd(), "src", "assets", "fonts"),
  join(process.cwd(), "packages", "frontend", "src", "assets", "fonts"),
];

async function readFont(name: string): Promise<ArrayBuffer> {
  let lastError: unknown;
  for (const dir of FONT_DIRS) {
    try {
      const bytes = await readFile(join(dir, name));
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

export function loadCardFonts() {
  fontsPromise ??= Promise.all([
    readFont("LibreFranklin-800.ttf"),
    readFont("PublicSans-400.ttf"),
  ]).then(([display, body]) => ({ display, body }));
  fontsPromise.catch(() => {
    fontsPromise = null;
  });
  return fontsPromise;
}
