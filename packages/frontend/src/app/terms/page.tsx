/*
 * DRAFTED FROM THE CODEBASE'S ACTUAL BEHAVIOR — the licensing table is LICENSING.md's, the
 * moderation powers are the documented roles, and the submission ceiling is the shipped product
 * rule. Needs owner/legal review before being treated as final, and re-checking whenever the
 * behavior it describes changes.
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
        The Hub republishes what funding programmes and their communities state, links every reader
        out to the programme&rsquo;s own application page, takes no applications and holds no money.
        It is provided <strong>as-is, without warranty of any kind</strong> — listings can be wrong,
        stale, or withdrawn by their programmes, and the Hub makes no promise of availability or
        accuracy.
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
        Submissions from accounts without a verified organisation membership go through review, and
        an account may keep at most five submissions awaiting review at once. The Hub may reject,
        unpublish, or remove content and accounts — through the documented review roles: verified
        organisations decide what publishes in their own name, Hub reviewers decide everywhere else.
        Every decision is recorded in a public audit trail. Rate limits apply to sign-in and API
        traffic. See <Link href="/how-it-works">how the Hub works</Link>.
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
