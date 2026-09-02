/**
 * HOW THE HUB WORKS, ordered as a lookup surface and readable as a short essay.
 *
 * The page now leads with the shortest useful path: what the Hub is, then the three steps from
 * sign-in to optional organization verification. Somebody ready to publish can leave from there;
 * everybody else gets a five-link contents strip before the reference material begins.
 *
 * TERMS COME BEFORE ROLES, so opportunity, listing, submission and namespace are defined before
 * any permission depends on them. The five role summaries stay open and directly below `#roles`,
 * because every 403 points there and a reader must never have to open a disclosure to understand
 * which role they hold.
 *
 * THE MATRIX REMAINS COMPLETE, because permissions are still a matrix rather than an essay. Its
 * seventeen actions and five roles are unchanged, but three row bands now expose the progression
 * from public reading, through getting listed, to decisions reserved for Hub staff. Repeated notes
 * moved to the nearby prose: export formats live under `#data`, while basic submission mechanics
 * live in the new publishing pathway.
 *
 * REASONING IS DISCLOSED, NOT DELETED. Verification stays open because readers need its warning;
 * the rationale for namespace decisions, the four neutral powers and the five-submission limit
 * sits in three closed details under `#why`. The limit also remains in the Submitter summary and
 * matrix row, so the operational fact is visible even while its policy argument is folded away.
 *
 * Nothing grants permission here; every cell describes the API and every fact stays linkable.
 */
import { SectionNav } from "@/components/SectionNav";
import {
  GOVERNANCE,
  PUBLISHERS_DOC,
  REPOSITORY,
  REVIEW_CRITERIA,
  RFC_PROCESS,
  STANDARD,
} from "@/lib/links";
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

const BANDS: { label: string; actions: Action[] }[] = [
  {
    label: "Anybody, without an account",
    actions: [
      {
        what: "Read the directory and open any listing",
        note: "No account, and no record of who read what.",
        can: { visitor: true, submitter: true, member: true, reviewer: true, admin: true },
      },
      {
        what: "Apply to a program",
        note: "Always on the program's own site.",
        can: { visitor: true, submitter: true, member: true, reviewer: true, admin: true },
      },
      {
        what: "Download the data",
        can: { visitor: true, submitter: true, member: true, reviewer: true, admin: true },
      },
    ],
  },
  {
    label: "Getting something listed",
    actions: [
      {
        what: "Submit an opportunity",
        can: { submitter: true, member: true, reviewer: true, admin: true },
      },
      {
        what: "Have more than five submissions waiting at once",
        note: "Five undecided at a time without one. A slot frees when one is decided.",
        can: { member: true, reviewer: true, admin: true },
      },
      {
        what: "Edit a listing",
        can: { submitter: "own", member: "own namespace", reviewer: true, admin: true },
      },
      {
        what: "See listings that are not published yet",
        can: { submitter: "own", member: "own namespace", reviewer: true, admin: true },
      },
      {
        what: "Publish without review",
        note: "A listing whose id is in a verified organization's namespace goes live on submission.",
        can: { member: "own namespace", reviewer: true, admin: true },
      },
      {
        what: "Approve a pending submission",
        note: "In its own namespace, that is the organization endorsing it, in its own name.",
        can: { member: "own namespace", reviewer: true, admin: true },
      },
      {
        what: "Reject a submission",
        note: "Always with a written reason, and always under the name of whoever decided.",
        can: { member: "own namespace", reviewer: true, admin: true },
      },
      {
        what: "Claim a listing for an organization",
        note: "Asks for an existing listing to move into your organization.",
        can: { submitter: true, member: true, reviewer: true, admin: true },
      },
    ],
  },
  {
    label: "Hub-only decisions",
    actions: [
      {
        what: "Decide a claim",
        can: { reviewer: true, admin: true },
      },
      {
        what: "Decide a suspected duplicate",
        note: "Confirm and merge into one listing, or dismiss.",
        can: { reviewer: true, admin: true },
      },
      {
        what: "Verify an organization",
        note: "The decision that turns an organization's submissions into instant publications.",
        can: { reviewer: true, admin: true },
      },
      {
        what: "Grant somebody membership of an organization",
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
    ],
  },
];

export default function HowItWorksPage() {
  return (
    <section>
      <h1>How the Hub works</h1>
      <p className="lede">
        The RFP Hub is an open index of funding opportunities. It <strong>republishes</strong> what
        programs state, under one open standard, and links every reader out to the program&rsquo;s
        own application page. It takes no applications, holds no money, and decides nobody&rsquo;s
        funding.
      </p>

      <section id="publish" className="card card-strong">
        <h2>Publish your first opportunity</h2>
        <ol>
          <li>
            <Link href="/dashboard">Sign in.</Link> The first sign-in creates the account — there is
            no separate signup.
          </li>
          <li>
            <Link href="/listings/new">Submit the opportunity.</Link> It waits for a Hub reviewer
            unless your organization is already verified.
          </li>
          <li>
            <Link href="/organizations">
              Get your organization verified — optional, and it is what removes the wait.
            </Link>{" "}
            A reviewer grants membership and verification. After that, your listings publish the
            moment you submit them.
          </li>
        </ol>
        <p className="muted footnote">
          Already listed by somebody else? <Link href="/">Open it in the directory</Link> and claim
          it — a reviewer decides who owns it.
        </p>
      </section>

      <SectionNav
        label="On this page"
        items={[
          { current: false, href: "#words", label: "The words this site uses" },
          { current: false, href: "#roles", label: "The five roles" },
          { current: false, href: "#matrix", label: "Who can do what" },
          { current: false, href: "#verified", label: 'What "verified" means' },
          { current: false, href: "#why", label: "Why it works this way" },
          { current: false, href: "#decisions", label: "How decisions are made" },
        ]}
      />

      <h2 id="words">The words this site uses</h2>
      <dl className="grid-2">
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
            organization and Hub staff can see one.
          </dd>
        </div>
        <div>
          <dt>Namespace</dt>
          <dd>
            The part of an id before the colon — <code>acme:round-4</code> is in <code>acme</code>.
            It names the organization a listing is published under.
          </dd>
        </div>
      </dl>

      <h2 id="roles">The five roles</h2>
      <dl className="grid-2">
        <div>
          <dt>Visitor</dt>
          <dd>
            Reads and applies without an account. This is most people, and the whole point of the
            site.
          </dd>
        </div>
        <div>
          <dt>Submitter</dt>
          <dd>
            Any signed-in account. Submits opportunities and edits its own. Everything it files
            waits for a decision — including a listing about a program you run — and{" "}
            <strong>five</strong> can be waiting at a time.
          </dd>
        </div>
        <div>
          <dt>Organization member</dt>
          <dd>
            An account a reviewer has attached to an organization. Sees everything filed in that
            organization&rsquo;s name, published or not. If the organization is{" "}
            <strong>verified</strong>, its members publish into its namespace instantly and decide —
            approve or reject — what anybody else files there.
          </dd>
        </div>
        <div>
          <dt>Hub reviewer</dt>
          <dd>
            Staff, and deliberately <strong>organization-agnostic</strong>: works every queue, in
            every namespace, including the ones they belong to and the ones they compete with. The
            only role that verifies organizations, grants memberships, and settles claims and
            duplicates.
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

      <h2 id="matrix">Who can do what</h2>
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
          {BANDS.map((band) => (
            <tbody key={band.label}>
              <tr className="matrix-band">
                <th scope="colgroup" colSpan={6}>
                  {band.label}
                </th>
              </tr>
              {band.actions.map((action) => (
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
                          // announces, because "•" read aloud in a seventeen-row table is noise.
                          <>
                            <span aria-hidden="true">•</span>
                            <span className="visually-hidden">yes</span>
                          </>
                        ) : cell ? (
                          <span className="muted">{cell}</span>
                        ) : (
                          <>
                            <span aria-hidden="true" className="muted">
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
          ))}
        </table>
      </div>

      <h2 id="verified">What &ldquo;verified&rdquo; means, and what it does not</h2>
      <p className="prose">
        Verification says a reviewer is satisfied that an organization&rsquo;s members speak for it.
        It is <strong>not</strong> an endorsement of the program, a check that its amounts are real,
        or a statement that it is a good place to apply.
      </p>
      <p className="prose">
        Separately, the Hub runs a <strong>low-bar anti-spam check</strong>: the application page
        exists and its title is about the same program. <em>Link looks right</em> means only that.
        No amount, deadline or eligibility rule here has been verified. Read the program&rsquo;s own
        page before you spend a week applying.
      </p>

      <h2 id="why">Why it works this way</h2>
      <p className="prose">
        A verified organization decides what publishes in its own namespace — approving or rejecting
        whatever anybody files there. Everything past its own namespace stays with Hub staff.
      </p>
      <details>
        <summary>Why an organization decides in its own namespace</summary>
        <p className="prose">
          A verified organization decides what publishes in its own namespace. Somebody outside the
          organization files a listing about your program; a member approves it — the organization
          saying <em>yes, this is ours and it is right</em> — or rejects it. Nobody is better placed
          to know.
        </p>
        <p className="prose">
          <strong>Decisions in your organization&rsquo;s name carry your name.</strong> A rejection
          needs a written reason, and both the reason and the handle of the member who wrote it go
          into the listing&rsquo;s history, which anybody can read. That is the whole safeguard, and
          it is deliberately the only one: an organization that can quietly bury an accurate listing
          about itself is a problem, and an organization that has to say why, in public, under a
          name, is not.
        </p>
      </details>
      <details>
        <summary>Why four powers stay with Hub staff</summary>
        <p className="prose">
          Everything past your own namespace stays with Hub staff. Verifying an organization,
          granting somebody membership of one, settling a claim over who owns a listing, deciding
          which of two near-identical listings survives — those are the four powers that could be
          used to widen a namespace&rsquo;s own reach, so they sit with people who have no stake in
          any of them. Reviewers are Hub staff rather than delegates precisely so that a reviewer
          decides on programs they compete with by the same rule as on programs they have never
          heard of.
        </p>
      </details>
      <details>
        <summary>Why five submissions at a time</summary>
        <p className="prose">
          An account with no verified membership can hold <strong>five</strong> submissions awaiting
          a decision. A slot frees as soon as one is decided — by a Hub reviewer, or by the
          organization the listing names.
        </p>
        <p className="muted prose">
          It keeps the queue honest. A queue anybody can fill without limit is a queue where the
          careful submission behind forty careless ones waits weeks for a person to reach it, and
          the first thing that goes is the review itself. Five is enough to file a whole grants
          program in one sitting, and few enough that everything in the queue is something somebody
          meant.
        </p>
      </details>

      <h2 id="data">The data is yours</h2>
      <p className="prose">
        Everything published here is available as bulk JSON and CSV exports and Atom and RSS feeds,
        under the same open standard the site itself uses — no scraping-required tier and no paid
        export.
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

      {/* A named region, so "the four governance links are in this section" is a checkable claim
          rather than "they are somewhere on this page". */}
      <section aria-labelledby="decisions">
        <h2 id="decisions">How decisions are made</h2>
        <p className="prose">
          Every rule on this page describes what the API actually enforces; the project&rsquo;s
          governance framework covers who gets to change those rules, what one listing is checked
          against before it publishes, how a proposed change to the Standard itself gets reviewed,
          and what happens when somebody disagrees with a decision.
        </p>
        <p className="row">
          <a href={GOVERNANCE} target="_blank" rel="noopener noreferrer">
            Governance
          </a>
          <a href={PUBLISHERS_DOC} target="_blank" rel="noopener noreferrer">
            Publishers
          </a>
          <a href={REVIEW_CRITERIA} target="_blank" rel="noopener noreferrer">
            Review criteria
          </a>
          <a href={RFC_PROCESS} target="_blank" rel="noopener noreferrer">
            RFC process
          </a>
        </p>
      </section>
    </section>
  );
}
