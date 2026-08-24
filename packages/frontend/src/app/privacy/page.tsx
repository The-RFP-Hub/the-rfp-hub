/*
 * DRAFTED FROM THE CODEBASE'S ACTUAL BEHAVIOR — every claim below was checked against the tree
 * (config.ts, analytics-hash.ts, better-auth.ts, the auth schema, LICENSING.md, exports/README.md)
 * on the day it was written. It still needs owner/legal review before being treated as final, and
 * it must be RE-CHECKED whenever the behavior it describes changes: a privacy page that drifts
 * from the code is worse than none.
 */
import { REPOSITORY } from "@/lib/links";

export default function PrivacyPage() {
  return (
    <section>
      <h1>Privacy</h1>
      <p className="lede">
        The RFP Hub is an open index of funding opportunities. Reading it requires no account and no
        personal data. This page says what the Hub collects when you do sign in, what it never
        collects, and how to get your data removed. Effective 24&nbsp;August&nbsp;2026.
      </p>

      <h2>What we collect</h2>
      <p>
        An account holds your <strong>email address</strong>, the <strong>handle</strong> you
        choose, and — if you sign in with Google — the <strong>name and profile photo</strong>{" "}
        Google shares. Beyond that, the Hub stores what you submit for publication: opportunity
        listings, organisation claims, and review decisions, each attributed to your account in a
        public audit trail.
      </p>

      <h2>Signing in</h2>
      <p>
        Email sign-in works by sending a one-time code to your address; your email is used to
        deliver that code and for nothing else. The email provider that carries the message sees the
        recipient address the way any mail carrier does. The session you receive is an opaque token
        stored as a database row — signing out deletes it, and revocation is immediate.
      </p>
      <p>
        Google sign-in requests only your name, email address and profile photo (the{" "}
        <code>openid email profile</code> scopes). The Hub asks for no offline access, stores no
        refresh token, and never calls a Google API on your behalf.
      </p>

      <h2>Analytics without addresses</h2>
      <p>
        Publishers see how many people viewed their listings. To count distinct visitors without
        keeping who they were, the Hub never stores IP addresses: each visit is recorded as a keyed
        hash (HMAC) of the address, and the current UTC date is part of the input — so the effective
        key rotates daily, yesterday&rsquo;s visits cannot be joined to today&rsquo;s, and the
        address itself is unrecoverable. Referrers are reduced to their host. Analytics events are
        retained for 180 days by default, then deleted.
      </p>

      <h2>Published data is public by design</h2>
      <p>
        Everything published on the Hub — listings, their audit trails, and the nightly dataset
        exports — is open data released under CC0. Published opportunity data remains in the
        published exports: unpublishing a listing stops it from appearing going forward, but
        snapshots already released are public records. Submit only what you intend to make public.
      </p>

      <h2>What we do not do</h2>
      <p>
        The Hub does not sell personal data, does not share it with third parties, runs no
        third-party trackers, and shows no advertising.
      </p>

      <h2>Deleting your data</h2>
      <p>
        Signing out revokes your session immediately. For account or data removal, open an issue or
        contact the maintainers through{" "}
        <a href={REPOSITORY} target="_blank" rel="noopener noreferrer">
          the project repository
        </a>
        . Note the public-by-design boundary above: account data can be removed; already-published
        CC0 snapshots cannot be recalled.
      </p>

      <h2>Changes to this policy</h2>
      <p>
        If this policy changes, the new version is published on this page with a new effective date.
      </p>
    </section>
  );
}
