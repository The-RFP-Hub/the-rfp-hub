/**
 * The three typefaces, SELF-HOSTED, in the one module that is allowed to know their names.
 *
 * WHY THIS DOES NOT WIDEN THE CONTENT-SECURITY-POLICY. `next/font/google` is not a `<link>` to a
 * font CDN. It resolves each family AT BUILD TIME, downloads the woff2 files into the build output,
 * and emits `@font-face` rules pointing at `/_next/static/media/…` on this origin. The browser
 * therefore fetches every glyph from the deployment itself: `font-src 'self' data:` stays exactly
 * as it was, no font CDN appears in `style-src`, and no reader's IP address reaches a third party
 * because they opened the directory. That is the same rule the stylesheet has always stated — it is
 * now kept with real typefaces rather than by doing without them. (The host names themselves are
 * deliberately not written anywhere under `src/`: a unit test scans this tree for them, and a
 * comment that spelled one out would either fail that scan or force it to be weakened.)
 *
 * The cost is honest and worth naming: the BUILD needs network access to Google's font endpoint the
 * first time it runs (Next caches the files afterwards). Nothing at runtime does.
 *
 * VARIABLE FONTS, so one file per family covers every weight the design uses — 400/600/700 body,
 * 700/800 display, 500 mono. Requesting fixed weights would ship five files to save nothing.
 *
 * FALLBACKS ARE CLOSE-METRIC ON PURPOSE. `next/font` also computes a size-adjusted local fallback
 * (`adjustFontFallback`, on by default) from the real font's metrics, so the pre-swap paint is
 * already the right size; the families listed below are what a browser uses when the download fails
 * outright. A directory that reflows the moment a font lands is a directory that moved the row
 * somebody was about to click.
 */
import { Libre_Franklin, Public_Sans, Spline_Sans_Mono } from "next/font/google";

/**
 * Display: headings and the wordmark. 700 and 800 only — this face is never body text, so it never
 * needs a reading weight.
 */
export const display = Libre_Franklin({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-display",
  fallback: ["Helvetica Neue", "Helvetica", "Arial", "sans-serif"],
});

/** Body and UI: everything a reader actually reads, and every control label. */
export const body = Public_Sans({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-body",
  fallback: ["-apple-system", "Segoe UI", "Helvetica", "Arial", "sans-serif"],
});

/**
 * Mono: identifiers, namespaces, error codes and field names. Anything a reader may have to copy
 * character by character, where an `l` and a `1` must not be the same shape.
 */
export const mono = Spline_Sans_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-mono",
  fallback: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
});

/** The class list that puts all three variables in scope. Applied once, on `<html>`. */
export const fontVariables = `${display.variable} ${body.variable} ${mono.variable}`;
