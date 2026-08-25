"use client";

/**
 * WHO CAN DO WHAT, said once, plainly, on a page anybody can read without an account.
 *
 * This page exists because the answer was previously distributed across a dozen footnotes — a
 * sentence on the submit form, a tooltip on a badge, a paragraph in an empty state — and none of
 * them could be linked to. A submitter who wanted to know why their listing was still pending, an
 * organisation wondering what "verified" would actually get them, and a new reviewer working out
 * the limits of their own role were all reading fragments.
 *
 * IT IS A TABLE, because the question is a matrix and prose is the wrong shape for a matrix. The
 * five roles are the columns a reader is trying to place themselves in; the rows are the actions
 * they are trying to find. Nothing here is a permission decision this client makes — every cell is
 * a description of what the API enforces, and the page says so rather than implying it is the
 * authority.
 *
 * THE SHAPE OF THE TABLE IS THE SCOPE OF EACH ROLE, and the phrase "own namespace" is doing most of
 * the work. A verified organisation decides — approves AND rejects — what publishes in its own
 * name; a Hub reviewer decides anywhere, and is the only one who can verify an organisation, grant
 * somebody membership of one, or settle a claim or a duplicate. Those four are exactly the powers
 * that would let a namespace grant itself more power, which is why they sit with a neutral party. A
 * paragraph saying "organisations moderate their own namespace" would be true and would still leave
 * a reader unable to work out which of the fifteen things below they may actually do.
 */
import { REPOSITORY, STANDARD } from "@/lib/links";
import { accountRoleLabel } from "@/lib/presentation";
import Link from "next/link";

/** The columns, narrowest capability first. Each role also holds everything to its left. */
const ROLES = [
  { key: "visitor", label: "Visitor" },
  { key: "submitter", label: accountRoleLabel("submitter") },
  { key: "member", label: "Verified org member" },
  { key: "reviewer", label: accountRoleLabel("reviewer") },
  { key: "admin", label: accountRoleLabel("admin") },
] as const;

type RoleKey = (typeof ROLES)[number]["key"];

/**
 * One row of the matrix.
 *
 * A cell is either "yes" (`•`), "no" (blank), or a QUALIFIED yes — a short phrase naming the limit.
 * The qualified cells are the ones that matter: "own namespace" appearing twice in the member
 * column is the whole shape of what verification grants.
 */
interface Action {
  what: string;
  note?: string;
  can: Partial<Record<RoleKey, true | string>>;
}

const ACTIONS: Action[] = [
  {
    what: "Read the directory and open any listing",
    note: "No account, no sign-in, no tracking of who read what.",
    can: { visitor: true, submitter: true, member: true, reviewer: true, admin: true },
  },
  {
    what: "Apply to a programme",
    note: "Always on the programme's own site. The Hub never takes applications.",
    can: { visitor: true, submitter: true, member: true, reviewer: true, admin: true },
  },
  {
    what: "Download the data",
    note: "Bulk JSON and CSV exports, and the Atom and RSS feeds.",
    can: { visitor: true, submitter: true, member: true, reviewer: true, admin: true },
  },
  {
    what: "Submit an opportunity",
    note: "Any account. It is stored immediately and waits for a decision.",
    can: { submitter: true, member: true, reviewer: true, admin: true },
  },
  {
    what: "Have more than five submissions waiting at once",
    note: "An account with no verified membership holds up to five undecided submissions. A slot frees the moment one is decided — by a Hub reviewer, or by the organisation it names.",
    can: { member: true, reviewer: true, admin: true },
  },
  {
    what: "Edit a listing",
    note: "Its own submitter, anyone in the organisation whose namespace it is in, or Hub staff.",
    can: { submitter: "own", member: "own namespace", reviewer: true, admin: true },
  },
  {
    what: "See listings that are not published yet",
    note: "Your own submissions; and, for a member, everything filed in the organisation's name.",
    can: { submitter: "own", member: "own namespace", reviewer: true, admin: true },
  },
  {
    what: "Publish without review",
    note: "A listing whose id is in a verified organisation's namespace goes live on submission.",
    can: { member: "own namespace", reviewer: true, admin: true },
  },
  {
    what: "Approve a pending submission",
    note: "A member approving one in their own namespace is the organisation endorsing it, in its own name.",
    can: { member: "own namespace", reviewer: true, admin: true },
  },
  {
    what: "Reject a submission",
    note: "Always with a written reason, and always under the name of whoever decided.",
    can: { member: "own namespace", reviewer: true, admin: true },
  },
  {
    what: "Claim a listing for an organisation",
    note: "Asks for an existing listing to be moved into your organisation's ownership.",
    can: { submitter: true, member: true, reviewer: true, admin: true },
  },
  {
    what: "Decide a claim",
    can: { reviewer: true, admin: true },
  },
  {
    what: "Decide a suspected duplicate",
    can: { reviewer: true, admin: true },
  },
  {
    what: "Verify an organisation",
    note: "The decision that turns an organisation's submissions into instant publications.",
    can: { reviewer: true, admin: true },
  },
  {
    what: "Grant somebody membership of an organisation",
    can: { reviewer: true, admin: true },
  },
  {
    what: "Change an account's role",
    can: { admin: true },
  },
  {
    what: "Run a maintenance job by hand",
    note: "Deadline sweeps, source verification, duplicate detection.",
    can: { admin: true },
  },
];

export default function HowItWorksPage() {
  return (
    <section>
      <h1>How the Hub works</h1>
      <p className="lede">
        The RFP Hub is an open index of funding opportunities. It <strong>republishes</strong> what
        programmes and their communities state, under one open standard, and links every reader out
        to the programme&rsquo;s own application page. It takes no applications, holds no money, and
        makes no decision about who gets funded.
      </p>

      <h2>The five roles</h2>

      <dl className="grid-2 card">
        <div>
          <dt>Visitor</dt>
          <dd>
            Reads everything published, with no account. Applies on the programme&rsquo;s own site.
            This is most people and the whole point of the site.
          </dd>
        </div>
        <div>
          <dt>Submitter</dt>
          <dd>
            Any account, created by signing in once. Submits opportunities and edits its own. Every
            submission waits for a decision before the public can see it — including submissions
            about a programme you run, until your organisation is verified. Up to{" "}
            <strong>five</strong> can be waiting at a time.
          </dd>
        </div>
        <div>
          <dt>Organisation member</dt>
          <dd>
            An account a reviewer has attached to an organisation. Sees everything filed in that
            organisation&rsquo;s name, published or not. If the organisation is{" "}
            <strong>verified</strong>, its members publish into its namespace instantly and decide —
            approve or reject — what anybody else files there.
          </dd>
        </div>
        <div>
          <dt>Hub reviewer</dt>
          <dd>
            A staff role, and deliberately <strong>organisation-agnostic</strong>: a reviewer works
            every queue, in every namespace, including the namespaces of organisations they belong
            to and the ones they compete with. Approves and rejects anywhere, and is the only role
            that verifies organisations, grants memberships, and settles claims and duplicates.
          </dd>
        </div>
        <div>
          <dt>{accountRoleLabel("admin")}</dt>
          <dd>
            Everything a reviewer can do, plus the accounts themselves: who holds which role, who
            may create API keys, and the maintenance jobs.
          </dd>
        </div>
      </dl>

      <h2>Who can do what</h2>
      <p className="footnote muted prose">
        A dot is an unqualified yes. A phrase is a real limit, and the limits are the interesting
        part. Every row describes what the <strong>API</strong> enforces — this page is a
        description of that, never a second permission system.
      </p>

      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">Action</th>
              {ROLES.map((role) => (
                <th key={role.key} scope="col">
                  {role.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ACTIONS.map((action) => (
              <tr key={action.what}>
                <th scope="row">
                  {action.what}
                  {action.note ? <div className="cell-note">{action.note}</div> : null}
                </th>
                {ROLES.map((role) => {
                  const cell = action.can[role.key];
                  return (
                    <td key={role.key}>
                      {cell === true ? (
                        // The visible mark is a dot; the word beside it is what a screen reader
                        // announces, because "•" read aloud in a fifteen-row table is noise.
                        <>
                          <span aria-hidden="true">•</span>
                          <span className="visually-hidden">yes</span>
                        </>
                      ) : cell ? (
                        <span className="muted">{cell}</span>
                      ) : (
                        <>
                          <span aria-hidden="true" className="faint">
                            —
                          </span>
                          <span className="visually-hidden">no</span>
                        </>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Deciding in your organisation&rsquo;s name</h2>
      <p className="prose">
        A verified organisation decides what publishes in its own namespace. Somebody outside the
        organisation files a listing about your programme; a member approves it — the organisation
        saying <em>yes, this is ours and it is right</em> — or rejects it. Nobody is better placed
        to know.
      </p>
      <p className="prose">
        <strong>Decisions in your organisation&rsquo;s name carry your name.</strong> A rejection
        needs a written reason, and both the reason and the handle of the member who wrote it go
        into the listing&rsquo;s history, which anybody can read. That is the whole safeguard, and
        it is deliberately the only one: an organisation that can quietly bury an accurate listing
        about itself is a problem, and an organisation that has to say why, in public, under a name,
        is not.
      </p>
      <p className="prose">
        Everything past your own namespace stays with Hub staff. Verifying an organisation, granting
        somebody membership of one, settling a claim over who owns a listing, deciding which of two
        near-identical listings survives — those are the four powers that could be used to widen a
        namespace&rsquo;s own reach, so they sit with people who have no stake in any of them.
        Reviewers are Hub staff rather than delegates precisely so that a reviewer decides on
        programmes they compete with by the same rule as on programmes they have never heard of.
      </p>

      <h2>Five waiting at a time</h2>
      <p className="prose">
        An account with no verified membership can hold <strong>five</strong> submissions awaiting a
        decision. A slot frees as soon as one is decided — by a Hub reviewer, or by the organisation
        the listing names.
      </p>
      <p className="muted prose">
        It keeps the queue honest. A queue anybody can fill without limit is a queue where the
        careful submission behind forty careless ones waits weeks for a person to reach it, and the
        first thing that goes is the review itself. Five is enough to file a whole grants programme
        in one sitting, and few enough that everything in the queue is something somebody meant.
      </p>

      <h2>What &ldquo;verified&rdquo; means, and what it does not</h2>
      <p className="prose">
        Verification says a reviewer has satisfied themselves that the people holding an
        organisation&rsquo;s membership really do speak for it. That is all. It is{" "}
        <strong>not</strong> an endorsement of the programme, a check that its amounts are real, or
        a statement that it is a good place to apply.
      </p>
      <p className="prose">
        Separately, the Hub runs a <strong>low-bar anti-spam check</strong> on each listing&rsquo;s
        application link: the page exists, and its title is about the same programme. A listing
        marked <em>link looks right</em> has passed that and nothing more. No amount, no deadline
        and no eligibility rule on this site has been verified by anyone. Read the programme&rsquo;s
        own page before you spend a week on an application.
      </p>

      <h2>The words this site uses</h2>
      <dl className="grid-2 card">
        <div>
          <dt>Opportunity</dt>
          <dd>The thing in the world — a grant round, a hackathon, a bounty, an RFP.</dd>
        </div>
        <div>
          <dt>Listing</dt>
          <dd>An opportunity as published here. Everything in the directory is a listing.</dd>
        </div>
        <div>
          <dt>Submission</dt>
          <dd>
            A listing that has been filed but not yet published. Only its submitter, its
            organisation and Hub staff can see one.
          </dd>
        </div>
        <div>
          <dt>Namespace</dt>
          <dd>
            The part of an id before the colon — <code>acme:round-4</code> is in <code>acme</code>.
            It names the organisation a listing is published under.
          </dd>
        </div>
      </dl>

      <h2>The data is yours</h2>
      <p className="prose">
        Everything published here is available in bulk and by feed, under the same open standard the
        site itself is built on. There is no scraping-required tier and no export that costs
        anything.
      </p>
      <p className="row">
        <a href={STANDARD} target="_blank" rel="noopener noreferrer">
          Read the Standard
        </a>
        <a href={REPOSITORY} target="_blank" rel="noopener noreferrer">
          The source, on GitHub
        </a>
        <Link href="/">Back to the directory</Link>
      </p>
    </section>
  );
}
