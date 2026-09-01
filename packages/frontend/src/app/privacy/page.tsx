/*
 * DRAFTED FROM THE CODEBASE'S ACTUAL BEHAVIOR and revised against an adversarial line-by-line
 * fact-check of every claim (config, auth, analytics, verification, export and deploy paths).
 * It still needs owner/legal review before being treated as final, and it must be RE-CHECKED
 * whenever the behavior it describes changes: a privacy page that drifts from the code is worse
 * than none.
 */
import { REPOSITORY } from "@/lib/links";

export default function PrivacyPage() {
  return (
    <section>
      <h1>Privacy</h1>
      <p className="lede">
        The RFP Hub is an open index of funding opportunities. No account is required to read the
        directory; like any web service, it still processes request metadata, described below. This
        page says what the Hub stores, what leaves its servers, what is public forever, and how to
        leave. Effective 31&nbsp;August&nbsp;2026.
      </p>

      <h2>What we store when you sign in</h2>
      <p>
        Your <strong>email address</strong> is your account&rsquo;s identity: it delivers your
        sign-in codes, is read whenever your session is checked and shown back to you on your
        account page, matches your Google account if you later link one, and is how an operator
        finds an account when granting a role. If a sign-in email fails to deliver, the failure log
        carries a short hashed fingerprint derived from the address — a stable identifier, not the
        address itself. One-time codes are stored hashed and expire in five minutes.
      </p>
      <p>
        Signing in creates a <strong>session</strong>: an opaque token stored as a database row,
        valid for 90 days and refreshed at most daily. Your browser keeps that token in{" "}
        <code>localStorage</code> until you sign out or clear site data. Signing out deletes the
        server row; if that request fails, this browser forgets the token but the server row can
        remain until it expires. Session rows deliberately store{" "}
        <strong>neither your IP address nor your browser&rsquo;s user-agent</strong> — no raw IP
        address is persisted in any application table. Transient operational and access logs at the
        hosting layer exist, as with any web service.
      </p>
      <p>
        <strong>Google sign-in</strong>, if you choose it, requests only your name, email and
        profile photo (the <code>openid email profile</code> scopes). Starting it sets a five-minute
        anti-forgery cookie backed by a ten-minute verification record. The tokens Google returns
        for the sign-in (access and ID token, their scope and expiry) are stored with the linked
        account; the Hub requests no offline access, so a refresh token is normally absent and is
        stored only if Google returns one. Sign-in exchanges tokens with Google&rsquo;s endpoints;
        beyond that, the Hub does not read your Google data.
      </p>
      <p>
        An account also carries what you create on it: an optional public handle (the byline shown
        on listings), roles and organization memberships, API-key records (name, prefix, a hash of
        the key, scopes, last-use — never the secret itself), your submissions, and an append-only
        history of changes and decisions.
      </p>

      <h2>Analytics without addresses</h2>
      <p>
        Publishers see <strong>event counts</strong> for their listings — recorded API list and
        detail reads, and clicks out to a listing&rsquo;s application page or source — not page
        views and not counts of distinct people. To record an event without keeping who made it,
        each event stores two truncated keyed hashes (HMACs): one over the address, user-agent and
        the current UTC date, one over the address and the date. The key is fixed, but because the
        date is part of the input, the stored identifiers change every day — rows from different
        days are not directly linkable without the key and a candidate address. Referrers are
        reduced to their host. Raw events are deleted after 180 days by a nightly job; aggregated
        daily counts remain.
      </p>
      <p>
        Separately from those publisher counts, the hosted site uses{" "}
        <strong>Google Analytics</strong> to measure overall site usage — pages visited and the
        coarse device and region information Google derives from a request. It is a standard
        third-party tool: when a page loads, your browser talks to Google&rsquo;s servers, which see
        your IP address, subject to{" "}
        <a href="https://policies.google.com/privacy" rel="noreferrer noopener" target="_blank">
          Google&rsquo;s privacy policy
        </a>
        . It runs only on deployments explicitly configured for it; the open-source code ships with
        it off, so a self-hosted Hub carries no Google Analytics unless its operator turns it on.
      </p>

      <h2>What is public forever</h2>
      <p>
        Published listings are open data: the RFP Hub Standard and the dataset exports are released
        under CC0. Unpublishing stops a listing from appearing going forward, but snapshots already
        released remain in the repository&rsquo;s history and in copies others have made. Submit
        only what you intend to make public — including any contact names or details inside listing
        content, which become part of the public dataset.
      </p>
      <p>
        If you choose a public handle, submissions you make outside an organization carry it as
        their <code>submittedBy</code> attribution — displayed on the listing and included in the
        exports. Without a handle, they are attributed to &ldquo;community&rdquo;. For listings that
        are currently public, a coarsened change history is also publicly readable: which fields
        changed and when, with reviewers shown only as &ldquo;reviewer&rdquo;. Other audit records
        are kept internally, append-only, and are not publicly served. The latest source check for a
        public listing (the URLs fetched, status, an extracted snapshot and differences) is publicly
        readable too.
      </p>

      <h2>What leaves our servers</h2>
      <p>
        The Hub runs on infrastructure providers that process data to provide the service: the site
        is hosted on Vercel, the API and database on AWS, and public dataset snapshots are published
        to GitHub. The email delivery provider sees your address in order to carry your sign-in
        codes, the way any mail carrier does. Google is involved if you choose Google sign-in, and
        through Google Analytics as described above.
      </p>
      <p>
        Listing text is processed for duplicate detection{" "}
        <strong>entirely on the Hub&rsquo;s own servers</strong> — no AI vendor, no third party,
        nothing sent anywhere. Submitting a listing with an application URL normally triggers a
        server-side check of that URL: the destination site sees a request from the Hub&rsquo;s
        servers with a Hub user-agent, carrying no cookies and no referrer.
      </p>
      <p>
        The Hub does not sell personal data and shows no advertising. Google Analytics, described
        above, is the only third-party measurement it runs.
      </p>

      <h2>How to leave</h2>
      <p>
        Signing out revokes this browser&rsquo;s session as described above. There is no self-serve
        account deletion yet: removal is a manual request to the maintainers through{" "}
        <a href={REPOSITORY} target="_blank" rel="noopener noreferrer">
          the project repository
        </a>{" "}
        (note that its issue tracker is public). Maintainers can remove identity records — email,
        name, photo — and revoke sessions and keys. What cannot be removed: the append-only audit
        history, and public attribution already released in CC0 snapshots or copied by others.
      </p>

      <h2>Changes to this policy</h2>
      <p>
        If this policy changes, the new version is published on this page with a new effective date.
      </p>
    </section>
  );
}
