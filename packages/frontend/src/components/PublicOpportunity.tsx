"use client";

/**
 * One published opportunity, as a visitor with no account reads it.
 *
 * IT READS THE PUBLIC ROUTE, AND THAT IS THE FEATURE. `GET /v1/opportunities/{id}` is where the API
 * counts a detail view, and `GET /v1/r/{id}/apply` is where it counts an apply click. A public page
 * that fetched an entry through any other route, or linked straight to the stored `applicationUrl`,
 * would leave a publisher's numbers at zero while people were reading and applying — the Analytics
 * tab would be quietly, unfixably wrong about the traffic this very page generated.
 *
 * The route serves `approved AND is_listed` entries only, so a 404 here is "not published", not
 * "missing". The workbench keeps its own owner and reviewer routes for the entries this one hides.
 *
 * EVERY STRING BELOW IS PUBLISHER-SUPPLIED and is rendered as text. That is the same guarantee the
 * signed-in pages give, and it matters more here: this is the surface an anonymous visitor reaches
 * without ever having decided to trust anyone.
 */
import { UntrustedBlock, UntrustedLink, UntrustedText } from "@/components/UntrustedText";
import { MatchBadge } from "@/components/badges";
import { EmptyState, ResourceView } from "@/components/states";
import { linkOutUrl } from "@/lib/api";
import {
  describeAward,
  describeDeadline,
  describeDeadlineEntry,
  formatAmount,
  formatInstant,
} from "@/lib/format";
import { useResource } from "@/lib/resource";
import { useApi } from "@/lib/session";
import type { Opportunity } from "@/lib/types";
import { useCallback } from "react";

export function PublicOpportunity({ id }: { id: string }) {
  const api = useApi();
  const load = useCallback(() => api.directory.find(id), [api, id]);
  const { state, reload } = useResource(load);

  return (
    <section>
      <ResourceView resource={state} what="this opportunity" onRetry={reload}>
        {(entry) => (
          <>
            <OpportunityView entry={entry} baseUrl={api.baseUrl} />
            <PublicHistory id={id} />
          </>
        )}
      </ResourceView>
    </section>
  );
}

/**
 * Split from the fetching component so a fixture can be rendered without a client — the whole
 * payload is a Standard object, and what has to be provable is that each of its fields reaches the
 * page as text rather than as markup.
 */
export function OpportunityView({ entry, baseUrl }: { entry: Opportunity; baseUrl: string }) {
  const source = entry.source ?? {};
  const funding = entry.fundingInfo;
  const award = describeAward(funding);
  const operator = entry.operatingOrganizations[0];

  return (
    <>
      <h1>
        <UntrustedText value={entry.title} />
      </h1>
      <p className="muted">
        <code>{entry.id}</code> · {entry.fundingType} · {entry.status}
        {operator ? (
          <>
            {" "}
            · run by <UntrustedText value={operator.name} />
          </>
        ) : null}
      </p>

      <div className="row">
        {entry.applicationUrl ? (
          <a
            href={linkOutUrl(baseUrl, entry.id, "apply")}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open the application page
          </a>
        ) : null}
        {entry.website ? (
          <a
            href={linkOutUrl(baseUrl, entry.id, "source")}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open the programme site
          </a>
        ) : null}
        {entry.applicationUrl || entry.website ? (
          <span className="muted footnote">
            Both hops go through the Hub, which is how the publisher sees that their listing was
            acted on. You land on the programme&rsquo;s own page.
          </span>
        ) : (
          <span className="muted">This entry states no application link.</span>
        )}
      </div>

      {entry.summary ? <UntrustedBlock value={entry.summary} /> : null}

      <dl className="grid-2 card">
        <div>
          <dt>Next deadline</dt>
          <dd>{describeDeadline(entry.deadlines)}</dd>
        </div>
        <div>
          <dt>Award</dt>
          <dd>{award ? <UntrustedText value={award} /> : <span className="muted">—</span>}</dd>
        </div>
        <div>
          <dt>Applications open</dt>
          <dd>{formatInstant(entry.opensAt)}</dd>
        </div>
        <div>
          <dt>Announced</dt>
          <dd>{formatInstant(entry.postedAt)}</dd>
        </div>
        <div>
          <dt>Committed to date</dt>
          <dd>
            <UntrustedText value={formatAmount(funding?.allocated, funding?.currency)} />
          </dd>
        </div>
        <div>
          <dt>Last updated here</dt>
          <dd>{formatInstant(entry.updatedAt)}</dd>
        </div>
      </dl>

      <h2>About this opportunity</h2>
      <UntrustedBlock value={entry.description} />

      <Prose title="Who may apply" value={entry.eligibility} />
      <Prose title="What a proposal must contain" value={entry.prerequisites} />
      <Prose title="Service agreement" value={entry.serviceAgreement} />
      <Prose title="Further references" value={entry.additionalReferences} />

      <Deadlines entry={entry} />
      <Milestones entry={entry} />
      <Organizations entry={entry} />
      <Tags entry={entry} />
      <Links entry={entry} />

      <details className="card">
        <summary>Type-specific details ({entry.fundingType})</summary>
        <p className="muted footnote">
          The Standard&rsquo;s <code>fundingDetails</code> block, verbatim. It is a different shape
          for each of the six funding types, so it is shown as the record itself carries it rather
          than through a per-type layout that could drop a field a publisher entered.
        </p>
        <pre className="untrusted-block">{JSON.stringify(entry.fundingDetails, null, 2)}</pre>
      </details>

      <section aria-labelledby="provenance-heading" className="card">
        <h2 id="provenance-heading">Where this record came from</h2>
        <p className="muted footnote">
          The Hub republishes what a publisher or a submitter stated. The check below is a{" "}
          <strong>low-bar anti-spam signal</strong> — the linked page exists and its title is about
          the same programme — and never a fact-check of the amounts or the dates.
        </p>
        <p>
          <MatchBadge matched={source.verifiedAgainstSource ?? null} />{" "}
          {source.verifiedAt ? (
            <span className="muted">last checked {formatInstant(source.verifiedAt)}</span>
          ) : null}
        </p>
        <dl className="grid-2">
          <div>
            <dt>Published under</dt>
            <dd>
              <UntrustedText value={source.publisher} fallback="no namespace" />
            </dd>
          </div>
          <div>
            <dt>Submitted by</dt>
            <dd>
              <UntrustedText value={source.submittedBy} fallback="not stated" />
            </dd>
          </div>
          <div>
            <dt>Submitted</dt>
            <dd>{formatInstant(source.submittedAt)}</dd>
          </div>
          <div>
            <dt>How it arrived</dt>
            <dd>
              <UntrustedText value={source.ingestedVia} fallback="not stated" />
            </dd>
          </div>
          <div>
            <dt>Id at the source</dt>
            <dd>
              <UntrustedText value={source.originalId} fallback="not stated" />
            </dd>
          </div>
          <div>
            <dt>Archived snapshot</dt>
            <dd>
              <UntrustedLink href={source.snapshotUrl} />
            </dd>
          </div>
        </dl>
        <p className="muted footnote">
          Conforms to RFP Hub Standard <code>{entry.specVersion}</code>.
        </p>
      </section>
    </>
  );
}

/** One free-text block, rendered only when the publisher filled it in. Never an empty heading. */
function Prose({ title, value }: { title: string; value: string | null | undefined }) {
  if (!value || value.trim() === "") return null;
  return (
    <>
      <h2>{title}</h2>
      <UntrustedBlock value={value} />
    </>
  );
}

/**
 * Every deadline the record carries, not only the next one.
 *
 * The array mixes application deadlines with event boundaries — a hackathon's start date is a
 * `deadlines[]` entry too — and the publisher's own label is the only thing that tells them apart,
 * so the label is shown rather than interpreted.
 */
function Deadlines({ entry }: { entry: Opportunity }) {
  const deadlines = entry.deadlines ?? [];
  if (deadlines.length === 0) return null;
  return (
    <section aria-labelledby="deadlines-heading">
      <h2 id="deadlines-heading">Dates</h2>
      <table>
        <thead>
          <tr>
            <th scope="col">What</th>
            <th scope="col">When</th>
          </tr>
        </thead>
        <tbody>
          {deadlines.map((deadline, index) => (
            <tr key={`${deadline.deadlineType}-${deadline.date ?? index}`}>
              <th scope="row">
                <UntrustedText value={deadline.label} fallback="unlabelled" />
              </th>
              <td>{describeDeadlineEntry(deadline)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/** The milestone sequence. Array order IS the sequence — there is no index field to sort on. */
function Milestones({ entry }: { entry: Opportunity }) {
  const milestones = entry.milestones ?? [];
  if (milestones.length === 0) return null;
  const currency = entry.fundingInfo?.currency;
  return (
    <section aria-labelledby="milestones-heading">
      <h2 id="milestones-heading">Milestones</h2>
      <table>
        <caption>In the order the publisher listed them</caption>
        <thead>
          <tr>
            <th scope="col">Milestone</th>
            <th scope="col">Amount</th>
            <th scope="col">Criteria</th>
          </tr>
        </thead>
        <tbody>
          {milestones.map((milestone, index) => (
            <tr key={`${milestone.title ?? "milestone"}-${index}`}>
              <th scope="row">
                <UntrustedText value={milestone.title} fallback="unnamed" />
              </th>
              <td>
                <UntrustedText value={formatAmount(milestone.amount, currency)} />
              </td>
              <td>
                <UntrustedText value={milestone.criteria} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/**
 * Who runs it and who backs it, kept apart.
 *
 * Operating and sponsoring are different roles and the Standard models them as different arrays:
 * the operator runs the intake and is who an applicant deals with, a sponsor may only have put money
 * behind it. Merging them into one "organisations" list is the misattribution that split them.
 */
function Organizations({ entry }: { entry: Opportunity }) {
  const sponsors = entry.sponsoringOrganizations ?? [];
  return (
    <section aria-labelledby="orgs-heading">
      <h2 id="orgs-heading">Organisations</h2>
      <dl className="grid-2">
        <div>
          <dt>Runs this opportunity</dt>
          <dd>
            <ul className="plain">
              {entry.operatingOrganizations.map((org) => (
                <li key={org.slug}>
                  <UntrustedText value={org.name} /> <code>{org.slug}</code>{" "}
                  {org.website ? <UntrustedLink href={org.website} label="site" /> : null}
                </li>
              ))}
            </ul>
          </dd>
        </div>
        <div>
          <dt>Backs it</dt>
          <dd>
            {sponsors.length === 0 ? (
              <span className="muted">none named</span>
            ) : (
              <ul className="plain">
                {sponsors.map((org) => (
                  <li key={org.slug}>
                    <UntrustedText value={org.name} /> <code>{org.slug}</code>{" "}
                    {org.website ? <UntrustedLink href={org.website} label="site" /> : null}
                  </li>
                ))}
              </ul>
            )}
          </dd>
        </div>
      </dl>
    </section>
  );
}

/** Ecosystems and categories — both open, free-text lists, so both are shown verbatim. */
function Tags({ entry }: { entry: Opportunity }) {
  const ecosystems = entry.ecosystems ?? [];
  const categories = entry.categories ?? [];
  if (ecosystems.length === 0 && categories.length === 0) return null;
  return (
    <dl className="grid-2">
      <div>
        <dt>Ecosystems</dt>
        <dd>
          <UntrustedText value={ecosystems.join(", ")} fallback="none stated" />
        </dd>
      </div>
      <div>
        <dt>Categories</dt>
        <dd>
          <UntrustedText value={categories.join(", ")} fallback="none stated" />
        </dd>
      </div>
    </dl>
  );
}

/**
 * The record's own URLs, shown as links rather than loaded.
 *
 * `logoUrl` and `bannerUrl` are deliberately NOT rendered as images: the page's own policy allows no
 * remote image at all, precisely so a publisher-supplied URL cannot report every reader's address to
 * whatever host a submitter named.
 */
function Links({ entry }: { entry: Opportunity }) {
  const socials = entry.socialLinks ?? [];
  const images = [
    ["Logo", entry.logoUrl],
    ["Banner", entry.bannerUrl],
  ] as const;
  const shownImages = images.filter(([, url]) => Boolean(url));
  if (!entry.website && !entry.applicationUrl && socials.length === 0 && shownImages.length === 0) {
    return null;
  }
  return (
    <section aria-labelledby="links-heading">
      <h2 id="links-heading">Links</h2>
      <p className="muted footnote">
        Shown as addresses rather than fetched. The two buttons at the top of this page are the
        counted hops; these are the raw values the record carries.
      </p>
      <dl className="grid-2">
        <div>
          <dt>Programme site</dt>
          <dd>
            <UntrustedLink href={entry.website} />
          </dd>
        </div>
        <div>
          <dt>Application page</dt>
          <dd>
            <UntrustedLink href={entry.applicationUrl} />
          </dd>
        </div>
        {shownImages.map(([label, url]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>
              <UntrustedLink href={url} />
            </dd>
          </div>
        ))}
        {socials.map((link) => (
          <div key={`${link.platform}-${link.url}`}>
            <dt>
              <UntrustedText value={link.platform} />
            </dt>
            <dd>
              <UntrustedLink href={link.url} />
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/**
 * The public, redacted mutation history.
 *
 * `GET /v1/opportunities/{id}/audit` authenticates optionally: a caller with no credential sees the
 * action, the time, a coarse actor and the NAMES of the fields that changed — never the patch, which
 * is reserved for the entry's own submitter, its publisher and reviewers. That is what makes it
 * publishable here: a visitor can see that a deadline was edited last week without seeing what it
 * was edited from.
 */
export function PublicHistory({ id }: { id: string }) {
  const api = useApi();
  const load = useCallback(() => api.opportunities.audit(id), [api, id]);
  const { state, reload } = useResource(load);

  return (
    <details className="card">
      <summary>Change history</summary>
      <p className="muted footnote">
        Append-only, and redacted for the public: the actions and the field names, not the values.
      </p>
      <ResourceView resource={state} what="the change history" onRetry={reload}>
        {(trail) =>
          trail.entries.length === 0 ? (
            <EmptyState title="No recorded changes." />
          ) : (
            <table>
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Action</th>
                  <th scope="col">Actor</th>
                  <th scope="col">Fields</th>
                </tr>
              </thead>
              <tbody>
                {trail.entries.map((audited) => (
                  <tr key={`${audited.at}-${audited.action}`}>
                    <td className="muted">{formatInstant(audited.at)}</td>
                    <td>{audited.action}</td>
                    <td>
                      <UntrustedText value={audited.actor} />{" "}
                      <span className="muted">({audited.actorKind})</span>
                    </td>
                    <td>
                      {audited.changedFields.length === 0 ? (
                        <span className="muted">—</span>
                      ) : (
                        <code>{audited.changedFields.join(", ")}</code>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        }
      </ResourceView>
    </details>
  );
}
