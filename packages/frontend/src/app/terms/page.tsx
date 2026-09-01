/*
 * DRAFTED FROM THE CODEBASE'S ACTUAL BEHAVIOR and revised against an adversarial fact-check: the
 * licensing split reproduces LICENSING.md exactly, the moderation powers are the ones the routes
 * actually grant, and the submission ceiling carries its real scope. Needs owner/legal review
 * before being treated as final, and re-checking whenever the behavior it describes changes.
 */
import { REPOSITORY, STANDARD } from "@/lib/links";
import Link from "next/link";

export default function TermsPage() {
  return (
    <section>
      <h1>Terms of Use</h1>
      <p className="lede">
        The RFP Hub is an open index of funding opportunities, provided as-is. These terms say what
        you agree to when you use it and what you license when you publish through it. Effective
        24&nbsp;August&nbsp;2026.
      </p>

      <h2>The service</h2>
      <p>
        The Hub republishes what funding programs and their communities state — reviewers may edit
        submissions before publication — and links readers out to a program&rsquo;s own application
        page where an entry carries an application link. It takes no applications and holds no
        money. It is provided <strong>as-is, without warranty of any kind</strong>: listings can be
        wrong, stale, or withdrawn by their programs, and the Hub makes no promise of availability
        or accuracy.
      </p>

      <h2>What you submit</h2>
      <p>
        Content you submit must be accurate to the best of your knowledge and lawful. By submitting,
        you license it for publication in the Hub&rsquo;s open dataset, which is released under{" "}
        <a
          href="https://creativecommons.org/publicdomain/zero/1.0/"
          target="_blank"
          rel="noopener noreferrer"
        >
          CC0-1.0
        </a>
        &nbsp;— published listings and the nightly exports are public records anyone may reuse.
      </p>

      <h2>Moderation</h2>
      <p>
        Submissions go through review before publication, with two exceptions: verified members of
        an organization publish directly in that organization&rsquo;s own name, and an account an
        admin has explicitly granted direct publication may publish with an eligible credential. An
        account holding no verified organization membership anywhere may keep at most five
        submissions awaiting review at once; editing an already-pending submission reuses its slot.
      </p>
      <p>
        The Hub may reject or unpublish content, demote roles, and revoke organization memberships
        and API keys — through the documented review roles: verified organizations decide what
        publishes in their own name, Hub reviewers decide everywhere else. Decisions on listings are
        recorded in an append-only history; for currently public listings, a coarsened version of
        that history is publicly readable. Sign-in and selected write and authenticated routes are
        rate-limited; public reading is not. See <Link href="/how-it-works">how the Hub works</Link>
        .
      </p>

      <h2>Licenses</h2>
      <p>
        The{" "}
        <a href={STANDARD} target="_blank" rel="noopener noreferrer">
          RFP Hub Standard
        </a>{" "}
        (schemas, generated types, field documentation) and the dataset exports are CC0-1.0; the
        Hub&rsquo;s code is MIT. The authoritative statement is the{" "}
        <a href={`${REPOSITORY}/blob/main/LICENSING.md`} target="_blank" rel="noopener noreferrer">
          licensing page in the repository
        </a>
        .
      </p>

      <h2>Changes</h2>
      <p>
        These terms may change; the current version is always this page, with its effective date
        above.
      </p>
    </section>
  );
}
