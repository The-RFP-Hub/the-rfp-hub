/**
 * The checker's XML reader — the only thing standing between "the deployment answered 200 with the
 * right content type" and "a consumer can actually read the feed".
 *
 * Two failure modes are tested in both directions, because getting either wrong is worse than
 * having no reader at all:
 *
 *   - too lax  — a document a real reader would reject (a bare `&`, a mismatched tag, JSON served
 *                under an XML media type) must not come back well-formed;
 *   - too strict — a perfectly parseable document that happens to use a comment, a CDATA section,
 *                a processing instruction, a doctype or a namespace prefix must not be reported as
 *                broken, because the checker is pointed at whatever a live deployment serves.
 */
import { describe, expect, it } from "vitest";
import { checkWellFormed } from "../xml.mjs";

/** An Atom document shaped like the one packages/api's feed mapper emits. */
const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>urn:rfphub:feed</id>
  <title>Opportunities</title>
  <updated>2026-01-01T00:00:00.000Z</updated>
  <link rel="self" type="application/atom+xml" href="https://example.org/v1/feeds/opportunities.atom"/>
  <entry>
    <id>https://example.org/v1/opportunities/x</id>
    <title>R&amp;D &quot;grants&quot; &lt;script&gt; &#38; more</title>
    <updated>2026-01-01T00:00:00.000Z</updated>
    <link rel="alternate" href="https://example.org/apply?a=1&amp;b=2"/>
    <summary type="text">A grant.</summary>
  </entry>
</feed>
`;

describe("checkWellFormed — documents a reader can parse", () => {
  it("accepts an Atom document, and says what it found", () => {
    const result = checkWellFormed(ATOM);
    expect(result.ok).toBe(true);
    expect(result.root).toBe("feed");
    expect(result.elements).toBe(11);
  });

  it("accepts an RSS document with namespaced element names", () => {
    const rss = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>Opportunities</title>
    <link>https://example.org/</link>
    <description>Recent opportunities.</description>
    <atom:link rel="self" type="application/rss+xml" href="https://example.org/v1/feeds/opportunities.rss"/>
    <item>
      <title>A grant</title>
      <guid isPermaLink="false">https://example.org/v1/opportunities/x</guid>
      <dc:creator>Feed &amp; Co</dc:creator>
    </item>
  </channel>
</rss>
`;
    const result = checkWellFormed(rss);
    expect(result.ok).toBe(true);
    expect(result.root).toBe("rss");
  });

  it("accepts comments, CDATA sections, processing instructions and a doctype", () => {
    const source = `<?xml version="1.0"?>
<!DOCTYPE feed>
<?xml-stylesheet type="text/xsl" href="/feed.xsl"?>
<!-- a comment before the root -->
<feed>
  <!-- and one inside it -->
  <title><![CDATA[Anything <at> all & unescaped]]></title>
  <?target instruction?>
</feed>
<!-- and one after -->
`;
    expect(checkWellFormed(source)).toMatchObject({ ok: true, root: "feed" });
  });

  it("accepts a byte-order mark and a document with no declaration", () => {
    expect(checkWellFormed("﻿<feed><title>x</title></feed>")).toMatchObject({ ok: true });
  });

  it("accepts an empty self-closed root", () => {
    expect(checkWellFormed('<feed xmlns="http://www.w3.org/2005/Atom"/>')).toMatchObject({
      ok: true,
      root: "feed",
      elements: 1,
    });
  });
});

describe("checkWellFormed — documents a reader would reject", () => {
  const rejects = (label, source, matcher) =>
    it(label, () => {
      const result = checkWellFormed(source);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(matcher);
    });

  rejects("a JSON body", '{"items":[],"total":0}', /expected '<'|no element/);
  rejects("an empty body", "", /no element/);
  rejects("an unterminated element", "<feed><title>x</title>", /unterminated element <feed>/);
  rejects("a mismatched closing tag", "<feed><title>x</feed>", /<\/feed> closes <title>/);
  rejects("a bare ampersand in text", "<feed><title>R&D grants</title></feed>", /unescaped '&'/);
  rejects(
    "a bare ampersand in an attribute value",
    '<feed><link href="https://e.org/?a=1&b=2"/></feed>',
    /unescaped '&'/,
  );
  rejects("an unknown entity", "<feed><title>&nbsp;</title></feed>", /unescaped '&'/);
  rejects("an unquoted attribute value", "<feed><link href=x/></feed>", /unquoted value/);
  rejects(
    "a duplicated attribute",
    '<feed><link rel="self" rel="alternate"/></feed>',
    /duplicate attribute/,
  );
  rejects("content after the root element", "<feed/><feed/>", /content after the root element/);
  rejects("an unterminated comment", "<feed><!-- open</feed>", /unterminated comment/);
  rejects("an unterminated CDATA section", "<feed><![CDATA[open</feed>", /unterminated CDATA/);
  rejects(
    "an HTML error page",
    "<!doctype html><html><body>502 Bad Gateway</body>",
    /invalid element or attribute name|unterminated element/,
  );
});
