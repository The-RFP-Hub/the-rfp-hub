"use client";

/**
 * The submit / replace form.
 *
 * Validation happens twice on purpose. In the browser, against the Standard, so a publisher sees
 * the problem next to the field; and on the API, which is the only validation that decides
 * anything. When the browser half is unavailable the form says so and submits anyway — the server's
 * humanized 400 is rendered in the same place the local errors would have been, so the failure mode
 * is a slower round trip rather than a silent all-clear.
 */
import { ActionNote } from "@/components/states";
import { ApiError } from "@/lib/api";
import { describeDuplicateCheck } from "@/lib/format";
import {
  FUNDING_TYPES,
  type OpportunityFormState,
  STATUSES,
  idProblem,
  toDocument,
} from "@/lib/opportunity-form";
import { useApi } from "@/lib/session";
import type { SubmissionResult } from "@/lib/types";
import { validateDocument } from "@/lib/validate-client";
import Link from "next/link";
import { useMemo, useState } from "react";

export function OpportunityForm({
  initial,
  mode,
  /** The stored record a replace is layered over. Empty on a create. */
  carried = {},
}: {
  initial: OpportunityFormState;
  mode: "create" | "edit";
  carried?: Record<string, unknown>;
}) {
  const api = useApi();
  const [form, setForm] = useState<OpportunityFormState>(initial);
  const [busy, setBusy] = useState(false);
  const [serverErrors, setServerErrors] = useState<string[]>([]);
  const [note, setNote] = useState<{ kind: "ok" | "error"; message: string } | null>(null);
  const [result, setResult] = useState<SubmissionResult | null>(null);

  // The stored record is the BASE the edited fields are written over, not a set of leftovers
  // merged after the fact: a shallow merge cannot preserve the members of a container this form
  // only half models (see `toDocument`).
  const built = useMemo(() => toDocument(form, carried), [form, carried]);
  const document = built.document;
  const validation = useMemo(() => validateDocument(document), [document]);
  const idIssue = mode === "create" ? idProblem(form.id) : null;

  const set = <K extends keyof OpportunityFormState>(key: K, value: OpportunityFormState[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const localErrors = [
    ...(idIssue ? [idIssue] : []),
    ...built.problems,
    ...(validation.available ? validation.errors : []),
  ];

  const submit = async () => {
    setBusy(true);
    setNote(null);
    setServerErrors([]);
    setResult(null);
    try {
      const response =
        mode === "create"
          ? await api.opportunities.create(document)
          : await api.opportunities.replace(form.id, document);
      setResult(response);
      setNote({
        kind: "ok",
        message: response.created ? "Submitted." : "Replaced.",
      });
    } catch (error) {
      if (error instanceof ApiError) {
        setServerErrors(error.details);
        setNote({ kind: "error", message: `${error.message} (${error.code})` });
      } else {
        setNote({ kind: "error", message: "The submission could not be sent." });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="grid-2">
        <div className="field">
          <label htmlFor="f-id">Id</label>
          <p className="hint">
            <code>&lt;namespace&gt;:&lt;local&gt;</code>, immutable once set. The namespace is an
            organisation slug and decides whether the entry publishes immediately.
          </p>
          <input
            id="f-id"
            value={form.id}
            readOnly={mode === "edit"}
            onChange={(event) => set("id", event.target.value)}
            required
          />
        </div>

        <div className="field">
          <label htmlFor="f-type">Funding type</label>
          <p className="hint">
            Also the tag inside <code>fundingDetails</code>; the two must agree.
          </p>
          <select
            id="f-type"
            value={form.fundingType}
            onChange={(event) => set("fundingType", event.target.value)}
          >
            {FUNDING_TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="field">
        <label htmlFor="f-title">Title</label>
        <input
          id="f-title"
          value={form.title}
          onChange={(event) => set("title", event.target.value)}
          required
        />
      </div>

      <div className="field">
        <label htmlFor="f-summary">Summary</label>
        <p className="hint">One or two sentences, for list and card views. Optional.</p>
        <input
          id="f-summary"
          value={form.summary}
          onChange={(event) => set("summary", event.target.value)}
        />
      </div>

      <div className="field">
        <label htmlFor="f-description">Description</label>
        <p className="hint">
          Markdown is permitted by the Standard. This frontend renders it as plain text everywhere,
          deliberately — see the README.
        </p>
        <textarea
          id="f-description"
          value={form.description}
          onChange={(event) => set("description", event.target.value)}
          required
        />
      </div>

      <div className="grid-2">
        <div className="field">
          <label htmlFor="f-status">Status</label>
          <select
            id="f-status"
            value={form.status}
            onChange={(event) => set("status", event.target.value)}
          >
            {STATUSES.map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="f-ecosystems">Ecosystems</label>
          <p className="hint">Comma-separated. Open list — no registry gate.</p>
          <input
            id="f-ecosystems"
            value={form.ecosystems}
            onChange={(event) => set("ecosystems", event.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="f-categories">Categories</label>
          <p className="hint">Comma-separated, free text.</p>
          <input
            id="f-categories"
            value={form.categories}
            onChange={(event) => set("categories", event.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="f-org-name">Operating organisation</label>
          <p className="hint">
            Who actually runs the intake — not necessarily who pays. Entry 0 is the one displayed.
          </p>
          <input
            id="f-org-name"
            value={form.orgName}
            onChange={(event) => set("orgName", event.target.value)}
            placeholder="Name"
            required
          />
        </div>

        <div className="field">
          <label htmlFor="f-org-slug">Operating organisation slug</label>
          <p className="hint">Lowercase, URL-safe. Also that organisation&rsquo;s namespace.</p>
          <input
            id="f-org-slug"
            value={form.orgSlug}
            onChange={(event) => set("orgSlug", event.target.value)}
            required
          />
        </div>

        <div className="field">
          <label htmlFor="f-apply">Application URL</label>
          <p className="hint">
            The one link back to the opportunity itself, and the target of the source check.
          </p>
          <input
            id="f-apply"
            value={form.applicationUrl}
            onChange={(event) => set("applicationUrl", event.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="f-website">Website</label>
          <input
            id="f-website"
            value={form.website}
            onChange={(event) => set("website", event.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="f-currency">Currency</label>
          <p className="hint">ISO 4217 code or token symbol, denominating every amount below.</p>
          <input
            id="f-currency"
            value={form.currency}
            onChange={(event) => set("currency", event.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="f-budget">Total budget</label>
          <input
            id="f-budget"
            inputMode="decimal"
            value={form.budget}
            onChange={(event) => set("budget", event.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="f-min">Minimum award</label>
          <input
            id="f-min"
            inputMode="decimal"
            value={form.minAward}
            onChange={(event) => set("minAward", event.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="f-max">Maximum award</label>
          <input
            id="f-max"
            inputMode="decimal"
            value={form.maxAward}
            onChange={(event) => set("maxAward", event.target.value)}
          />
        </div>
      </div>

      <div className="field">
        <label htmlFor="f-eligibility">Eligibility</label>
        <p className="hint">Free text, in your own words. Deliberately not structured data.</p>
        <textarea
          id="f-eligibility"
          value={form.eligibility}
          onChange={(event) => set("eligibility", event.target.value)}
        />
      </div>

      <div className="field">
        <label htmlFor="f-details">Funding details (JSON)</label>
        <p className="hint">
          The type-specific object. Its <code>fundingType</code> tag must equal the one above. A
          typed form per funding type is not in this cut.
        </p>
        <textarea
          id="f-details"
          value={form.fundingDetails}
          onChange={(event) => set("fundingDetails", event.target.value)}
        />
      </div>

      <div className="field">
        <label htmlFor="f-deadlines">Deadlines (JSON array)</label>
        <p className="hint">
          Optional. Each entry is a fixed date or rolling, distinguished by its label.
        </p>
        <textarea
          id="f-deadlines"
          value={form.deadlines}
          onChange={(event) => set("deadlines", event.target.value)}
        />
      </div>

      {!validation.available ? <p className="note error">{validation.reason}</p> : null}

      {localErrors.length > 0 ? (
        <div className="state error" role="alert">
          <p>
            <strong>Not conformant yet:</strong>
          </p>
          <ul>
            {localErrors.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {validation.available && validation.warnings.length > 0 ? (
        <div className="state">
          <p>
            <strong>Advisory warnings</strong> — the document is still conformant with these.
          </p>
          <ul>
            {validation.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {serverErrors.length > 0 ? (
        <div className="state error" role="alert">
          <p>
            <strong>The API rejected this document:</strong>
          </p>
          <ul>
            {serverErrors.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <p className="row">
        <button type="submit" disabled={busy || localErrors.length > 0}>
          {busy ? "Sending…" : mode === "create" ? "Submit" : "Replace"}
        </button>
        <ActionNote note={note} />
      </p>

      {result ? <SubmissionOutcome result={result} /> : null}
    </form>
  );
}

/**
 * What actually happened to the submission.
 *
 * `reviewStatus` and the duplicate check are the two things a publisher misreads if they are not
 * spelled out: a `pending` entry is stored and invisible, and an empty duplicate list means
 * "nothing similar" only when the check ran at all.
 */
function SubmissionOutcome({ result }: { result: SubmissionResult }) {
  return (
    <div className="card">
      <h2>Result</h2>
      <p>
        {result.reviewStatus === "approved" && result.isListed
          ? "Published — it is in the public reads now."
          : result.reviewStatus === "pending"
            ? "Stored as pending. It is invisible to the public reads until a reviewer approves it; publishing immediately requires membership of a verified organisation for this namespace."
            : `Stored with review status ${result.reviewStatus}.`}
      </p>
      <p>{describeDuplicateCheck(result.duplicateCheck, result.duplicates.length)}</p>
      {result.duplicates.length > 0 ? (
        <ul>
          {result.duplicates.map((match) => (
            <li key={match.id}>
              <Link href={`/listings/${encodeURIComponent(match.id)}`}>{match.title}</Link>{" "}
              <code>{match.id}</code>
            </li>
          ))}
        </ul>
      ) : null}
      {result.warnings.length > 0 ? (
        <>
          <p>
            <strong>Advisory warnings from the API:</strong>
          </p>
          <ul>
            {result.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </>
      ) : null}
      <p>
        <Link href={`/listings/${encodeURIComponent(result.opportunity.id)}`}>Open this entry</Link>
      </p>
    </div>
  );
}
