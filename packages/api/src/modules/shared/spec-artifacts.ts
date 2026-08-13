/**
 * THE PUBLICATION TREE — the Standard's published directories, mirrored file for file.
 *
 * `canonical-documents.ts` serves the FIVE documents the Standard mints an identifier for. This
 * module serves the directories those identifiers live in, whole: the informative documents of the
 * frozen version directory (`FIELDS.md`, `CROSSWALK.md`, `BENCHMARK.md`, `STATUS.md`), the `FROZEN`
 * marker itself, the 30 curated examples, and the four registry vocabularies — each at exactly the
 * path the package's own layout gives it.
 *
 * WHY THE WHOLE DIRECTORY. `schemas/v1.0.0/STATUS.md` states that the identifiers mirror "this
 * package's own directory layout", and `adr/0007` calls the end state "a publication tree mirroring
 * `$id` byte-for-byte". A tree that reproduces the layout for five files and 404s the other
 * thirty-seven is not a mirror, it is a shortlist: `FIELDS.md` links to `./context.jsonld` and
 * `../../registries/deadline-labels.json`, `CROSSWALK.md` links back to the schema, and every one
 * of those relative links resolves against a served document's own URL. Serving the directory
 * read-only is the smallest thing that makes the layout true, and it is precisely what the recorded
 * migration to object storage does — publish the directory — so the API's behaviour today and the
 * CDN's behaviour later are the same behaviour, which is what makes that migration a no-op.
 *
 * WHICH DIRECTORIES. Exactly the three prefixes `adr/0007` scopes the apex listener rule to:
 * `/schemas/`, `/meta/`, `/registries/`. That rule is the infrastructure half of the apex
 * reservation, and serving a tree the load balancer does not forward would publish something on
 * the identifier authority that is unreachable through it. `conformance/` is therefore deliberately
 * absent: it ships in the package's `files` array for implementers to run offline, no identifier
 * names it, and it is not one of the forwarded prefixes. `dist/` and the package's root Markdown
 * are source, not identifiers.
 *
 * SECURITY — the allowlist IS the route table. The trees are walked ONCE, at boot, and one route is
 * registered per file found. No request path ever reaches the filesystem: there is nothing to join,
 * nothing to normalise, and no `realpath` check to get subtly wrong, because the only paths this
 * process will ever open are the ones `readdirSync` returned before the server started listening.
 * A `..` segment in a request is simply a path no route matched, answered by the app's own
 * not-found handler in the API's error shape.
 *
 * COST. The tree is read into memory at boot — the same thing `canonical-documents.ts` already does
 * for its five, and about 340 KB in total for all of it. That buys byte-identity (the bytes served
 * are the bytes read, never a re-serialization), a content-derived `ETag` computed once, and no
 * filesystem access on the request path at all.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, posix } from "node:path";
import {
  type ServedSpecDocument,
  cachePolicyFor,
  canonicalDocuments,
  entityTag,
  specConfig,
  standardPackageRoot,
} from "./canonical-documents.js";

/**
 * The directories the Standard publishes under its canonical authority.
 *
 * Not a guess about the package's contents: these are the three path prefixes `adr/0007` says the
 * apex listener rule forwards, and the package's `exports` map exposes each of them as a subpath
 * pattern. Adding a fourth is an infrastructure decision as much as a code one.
 */
export const PUBLISHED_TREES = Object.freeze(["schemas", "meta", "registries"] as const);

/**
 * What a file's name says it is.
 *
 * The media type IS the interoperability contract — a JSON Schema document served as
 * `application/json` is not `$ref`-able by a generic validator, and a context served as anything
 * but `ld+json` is not a context — so it is decided by suffix here and cross-checked against
 * `canonicalDocuments`' hand-declared types in the tests, where a disagreement is a failure.
 *
 * `.meta.json` is a JSON Schema too (the metaschema our own schema validates against), which is
 * why the schema test is not simply `.schema.json`. Markdown and the extensionless `FROZEN` marker
 * carry an explicit `charset`: HTTP defines no default for `text/*`, and a reader that guesses
 * latin-1 mangles every non-ASCII character in `FIELDS.md`. The `+json` types need none — JSON is
 * UTF-8 by definition (RFC 8259 § 8.1).
 */
export function mediaTypeFor(source: string): string {
  if (source.endsWith(".jsonld")) return "application/ld+json";
  if (source.endsWith(".schema.json") || source.endsWith(".meta.json")) {
    return "application/schema+json";
  }
  if (source.endsWith(".json")) return "application/json";
  if (source.endsWith(".md")) return "text/markdown; charset=utf-8";
  return "text/plain; charset=utf-8";
}

/** One file of the published tree, ready to send. */
export interface SpecArtifact extends ServedSpecDocument {
  /** The route path — the package subpath, given a leading slash. */
  path: string;
  /** The URL this file has on the canonical authority. */
  url: string;
  /** The package subpath the bytes come from; equal to `path` minus its leading slash. */
  source: string;
}

/**
 * Every regular file under `relative`, depth-first, as package subpaths.
 *
 * REGULAR files only. `standardPackageRoot` is a real path (Node resolves symlinks unless
 * `--preserve-symlinks`), so everything below it is the package's own content — but publishing a
 * symlink's target at a spec URL is not something this should be able to do by accident, and
 * `isFile()` is the whole of the fix.
 *
 * POSIX joins on purpose: these become URL paths, and on Windows `path.join` would produce
 * backslashes that are not path separators in a URL.
 */
function walk(relative: string): string[] {
  const entries = readdirSync(join(standardPackageRoot, relative), { withFileTypes: true });
  return entries.flatMap((entry) => {
    const child = posix.join(relative, entry.name);
    if (entry.isDirectory()) return walk(child);
    return entry.isFile() ? [child] : [];
  });
}

/** The package the tree comes from, named once so the boot error can quote it. */
const STANDARD_PACKAGE = "@the-rfp-hub/standard";

function buildPublicationTree(): SpecArtifact[] {
  let sources: string[];
  try {
    sources = PUBLISHED_TREES.flatMap((tree) => walk(tree));
  } catch (cause) {
    // The one failure this deployment actually has: an image that installed the package's `dist`
    // but not its data directories. Saying so at boot beats 404ing every identifier at runtime.
    const required = PUBLISHED_TREES.map((tree) => `${tree}/`).join(", ");
    throw new Error(
      `the Standard's published tree is not on disk at ${standardPackageRoot} — ` +
        `the runtime must carry ${required} from ${STANDARD_PACKAGE}, not just its dist/`,
      { cause },
    );
  }

  // readdir order is filesystem-dependent; sorting makes the route table, and every test that
  // enumerates it, identical on every machine.
  return sources.sort().map((source) => {
    const path = `/${source}`;
    const body = readFileSync(join(standardPackageRoot, source));
    return {
      path,
      url: `${specConfig.baseUrl}${path}`,
      source,
      mediaType: mediaTypeFor(source),
      body,
      cacheControl: cachePolicyFor(path),
      etag: entityTag(body),
    };
  });
}

/** The published tree, read once at boot. A SUPERSET of `canonicalDocuments`, by construction. */
export const specArtifacts: readonly SpecArtifact[] = Object.freeze(buildPublicationTree());

/** Every path the tree publishes — the apex allowlist, and the mirror's own allowlist. */
export const specArtifactPaths: ReadonlySet<string> = new Set(specArtifacts.map((a) => a.path));

/**
 * Fail at BOOT if the mirror does not contain every identifier the Standard mints.
 *
 * The two modules read the same package by two different routes — `canonical-documents.ts` through
 * the `exports` map one subpath at a time, this one by walking the directory — and the whole claim
 * being made is that those agree. If a future package layout moved an identifier out of the three
 * published trees, the identifier would still resolve (its own route is registered independently)
 * while the tree around it silently stopped containing it. That is the drift worth catching, and it
 * costs one set lookup per document at startup.
 */
export function assertPublicationTreeCoversIdentifiers(): void {
  for (const doc of canonicalDocuments) {
    if (specArtifactPaths.has(doc.path)) continue;
    throw new Error(
      `canonical document ${doc.source} is served at ${doc.path} but is not inside the published ` +
        `tree (${PUBLISHED_TREES.join(", ")})`,
    );
  }
}
