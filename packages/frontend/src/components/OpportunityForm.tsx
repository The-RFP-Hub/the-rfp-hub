"use client";

import { GuardedLink, useNavigationBlocker } from "@/components/NavigationBlocker";
/**
 * The submit / replace form.
 *
 * FOUR DECISIONS shape everything below, and each replaced something that was worse.
 *
 * 1. THE STANDARD IS TYPED HERE, NOT PASTED. `fundingDetails` used to be a JSON textarea, on the
 *    reasoning that six shapes were too many to model. They are six shapes with a discriminator,
 *    which is the exact thing a form is good at; what the textarea really did was hand the schema's
 *    conditional rules to the publisher and let them find out from a 400. Every branch, every
 *    repeating group and every conditional is a control now — including the ones that CLEAR rather
 *    than hide, because the schema false-forbids the members a shape does not use.
 * 2. VALIDATION HAPPENS TWICE, ON PURPOSE. In the browser against the Standard, so a publisher sees
 *    the problem next to the field; and on the API, which is the only validation that decides
 *    anything. `rfphub-validate` stays the authoritative local pass — the per-field rules in
 *    `opportunity-form.ts` exist to ADDRESS a failure to an input, not to replace it. When the
 *    browser half is unavailable the form says so and submits anyway, and the API's humanized 400
 *    lands in the same place the local errors would have.
 * 3. PROBLEMS ARRIVE WHEN THEY ARE DUE. A field's problem shows once that field has been left, or
 *    once Submit has been pressed; the summary panel waits for the press. An empty form covered in
 *    red before anybody has typed is a form telling somebody off for not having started.
 * 4. SUBMIT IS ALWAYS LIVE. A disabled button that does not say why is a dead end — the publisher
 *    cannot tell a broken page from an unmet rule. Pressing it on a document with problems reveals
 *    them instead of sending. And once something HAS been sent, the result replaces the form: the
 *    old screen kept a live Submit button under the outcome panel, which is a second submission
 *    waiting to happen.
 */
import styles from "@/components/OpportunityForm.module.css";
import { PublisherJourney } from "@/components/PublisherJourney";
import { UntrustedText } from "@/components/UntrustedText";
import { PublisherStatusBadge } from "@/components/badges";
import {
  CheckField,
  CheckList,
  Field,
  type FieldChrome,
  Repeatable,
  Section,
  SelectField,
  SuggestField,
  TextArea,
  TextField,
  fieldId,
} from "@/components/form-fields";
import { ActionNote, actionErrorNote } from "@/components/states";
import { ApiError } from "@/lib/api";
import { describeDuplicateCheck, formatInstant, formatSimilarity } from "@/lib/format";
import {
  BEFORE_DRAFTS_CLEARED_EVENT,
  canonicalForm,
  readOpportunityDraft,
  removeOpportunityDraft,
  writeOpportunityDraft,
} from "@/lib/opportunity-draft";
import {
  ACCELERATOR_STAGES,
  BOUNTY_ASSET_TYPES,
  BOUNTY_KINDS,
  BOUNTY_SEVERITIES,
  CONTACT_METHODS,
  DEADLINE_LABELS,
  DEADLINE_TYPES,
  DIFFICULTIES,
  type DeadlineRow,
  type DetailsState,
  FUNDING_MECHANISMS,
  FUNDING_TYPES,
  type FundingType,
  type MilestoneRow,
  ORG_TYPES,
  type OpportunityFormState,
  type OrganizationRow,
  PAYOUT_BASES,
  PAYOUT_MODELS,
  PROGRAM_MODELS,
  type PayoutModel,
  type PrizeRow,
  type PublishAuthority,
  REWARD_POOL_STATUSES,
  type RewardTierRow,
  SOCIAL_PLATFORMS,
  STATUSES,
  type SocialLinkRow,
  type Tri,
  VC_STAGES,
  deriveId,
  describePublish,
  emptyDeadline,
  emptyForm,
  emptyMilestone,
  emptyOrganization,
  emptyPrize,
  emptyRewardTier,
  emptySocialLink,
  localTimeZoneDescription,
  moveRow,
  namespaceAuthority,
  parseValidationIssueLine,
  removeRow,
  replaceRow,
  toDocument,
  utcPreview,
  validationPointerToFormPath,
} from "@/lib/opportunity-form";
import { fundingTypeLabel, opportunityStatusLabel, publisherStatus } from "@/lib/presentation";
import { useApi } from "@/lib/session";
import type { SubmissionResult, ValidationIssue } from "@/lib/types";
import { validateDocument } from "@/lib/validate-client";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

/**
 * What to SHOW for the schema's tokens.
 *
 * `vc_fund`, `up_to` and `value_at_risk` are wire forms. Rendering them raw in a dropdown asks a
 * publisher to read the schema; the value stored is the token either way.
 */
const LABELS: Readonly<Record<string, string>> = {
  ...Object.fromEntries(FUNDING_TYPES.map((value) => [value, fundingTypeLabel(value)])),
  ...Object.fromEntries(STATUSES.map((value) => [value, opportunityStatusLabel(value)])),
  fixed: "Fixed date",
  rolling: "Rolling",
  task: "Task",
  security: "Security",
  single: "A single reward",
  tiers: "A reward table",
  up_to: "Up to",
  range: "Range",
  percentage: "Percentage",
  discretionary: "Discretionary",
  value_at_risk: "value at risk",
  economic_damage: "economic damage",
  funded: "Funded",
  unfunded: "Unfunded",
  unknown: "Unknown",
  email: "Email",
  form: "A form",
  "intro-only": "Warm introduction only",
};

/**
 * SECTION NAMES FOLLOW THE SCHEMA where a section maps to a schema field.
 *
 * "Money" and "Dates" read better in isolation and were the wrong call: a publisher reading a
 * conformance error about `fundingInfo` or `deadlines` has to guess which part of the form owns it,
 * and a reviewer quoting a field name is talking about something the form does not name. So the
 * envelope section is "Funding information" (`fundingInfo`), the date section names `deadlines`
 * outright, and the type-specific section is "Funding details — <type>" (`fundingDetails`). The
 * purely organisational sections — what it is, who runs it, identity, reach — map to no single
 * field and keep descriptive names.
 */
const DETAILS_SUFFIX: Record<FundingType, string> = {
  grant: fundingTypeLabel("grant"),
  hackathon: fundingTypeLabel("hackathon"),
  bounty: fundingTypeLabel("bounty"),
  accelerator: fundingTypeLabel("accelerator"),
  vc_fund: fundingTypeLabel("vc_fund"),
  rfp: fundingTypeLabel("rfp"),
};

const detailsTitle = (type: FundingType) => `Funding details — ${DETAILS_SUFFIX[type]}`;

const ERROR_SUMMARY_ID = "form-error-summary";

interface FormIssue {
  /** Form path, `(root)`, or null when the issue cannot safely target a control. */
  path: string | null;
  message: string;
  raw: string;
}

function mapValidationIssue(
  issue: ValidationIssue,
  raw: string,
  fundingType: FundingType,
): FormIssue {
  return {
    path: validationPointerToFormPath(issue.path, fundingType),
    message: issue.message,
    raw,
  };
}

function issuesFromApi(error: ApiError, fundingType: FundingType): FormIssue[] {
  if (error.issues.length === 0) {
    return error.details.map((line) => {
      const parsed = parseValidationIssueLine(line);
      return {
        ...parsed,
        path: parsed.path ? validationPointerToFormPath(parsed.path, fundingType) : null,
      };
    });
  }
  const structured = error.issues.map((issue, index) =>
    mapValidationIssue(
      issue,
      error.details[index] ?? `${issue.path} ${issue.message}`,
      fundingType,
    ),
  );
  const residue = error.details.slice(error.issues.length).map((line) => {
    const parsed = parseValidationIssueLine(line);
    return {
      ...parsed,
      path: parsed.path ? validationPointerToFormPath(parsed.path, fundingType) : null,
    };
  });
  return [...structured, ...residue];
}

const FIELD_LABELS: Readonly<Record<string, string>> = {
  id: "Listing id",
  fundingType: "Funding type",
  title: "Title",
  summary: "Summary",
  description: "Description",
  status: "Application stage",
  budget: "Budget",
  allocated: "Allocated",
  minAward: "Minimum award",
  maxAward: "Maximum award",
  opensAt: "Opens at",
  postedAt: "Posted at",
  operatingOrganizations: "Running organisations",
  sponsoringOrganizations: "Sponsoring organisations",
  programModel: "Programme model",
};

function issueLabel(path: string | null): string | null {
  if (!path) return null;
  if (path === "(root)") return "Whole form";
  const parts = path.split(".");
  const leaf = parts.at(-1) ?? path;
  const plain =
    FIELD_LABELS[path] ??
    FIELD_LABELS[leaf] ??
    leaf.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  const index = parts.findIndex((part) => /^\d+$/.test(part));
  if (index > 0) {
    const row = Number(parts[index]) + 1;
    const group = parts[index - 1];
    if (group === "operatingOrganizations" || group === "sponsoringOrganizations") {
      return `Organisation ${row} — ${plain}`;
    }
    if (group === "deadlines") return `Deadline ${row} — ${plain}`;
    if (group === "socialLinks") return `Social link ${row} — ${plain}`;
    if (group === "milestones") return `Milestone ${row} — ${plain}`;
    if (group === "prizes") return `Prize ${row} — ${plain}`;
    if (group === "rewardTiers") return `Reward tier ${row} — ${plain}`;
  }
  return plain.charAt(0).toUpperCase() + plain.slice(1);
}

export function OpportunityForm({
  initial,
  mode,
  accountId,
  /** The stored record a replace is layered over. Empty on a create. */
  carried = {},
  /**
   * What the API says this account may publish, for the live consequence line under the id.
   * Optional: without it the form says the rule rather than the outcome, which is honest, and it
   * keeps this component renderable by anything that has a form but not a session.
   */
  authority,
}: {
  initial: OpportunityFormState;
  mode: "create" | "edit";
  /** Create drafts are isolated by the API account id; edit mode never persists a draft. */
  accountId?: number;
  carried?: Record<string, unknown>;
  authority?: PublishAuthority;
}) {
  const api = useApi();
  const [form, setForm] = useState<OpportunityFormState>(initial);
  // `fromDocument(entry)` creates new row keys every time it is called. Capture the canonical
  // initial state exactly once so a parent render cannot manufacture a dirty edit.
  const initialSnapshot = useRef(canonicalForm(initial));
  const latestForm = useRef(form);
  latestForm.current = form;
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverIssues, setServerIssues] = useState<FormIssue[]>([]);
  const [serverValidationLines, setServerValidationLines] = useState<string[]>([]);
  const [focusSummary, setFocusSummary] = useState(0);
  const errorSummaryRef = useRef<HTMLDivElement>(null);
  const [note, setNote] = useState<{ kind: "ok" | "error"; message: string } | null>(null);
  const [result, setResult] = useState<SubmissionResult | null>(null);
  const [draftPrompt, setDraftPrompt] = useState<{
    form: OpportunityFormState;
    savedAt: string;
  } | null>(null);
  const [draftReady, setDraftReady] = useState(false);
  const [draftStatus, setDraftStatus] = useState<
    { kind: "saved"; savedAt: string } | { kind: "error" } | null
  >(null);
  const draftReadyRef = useRef(false);
  const skipDraftCleanup = useRef(false);
  const draftTimer = useRef<number | undefined>(undefined);
  const { setBlocked } = useNavigationBlocker();

  const dirty = canonicalForm(form) !== initialSnapshot.current;

  const persistDraft = useCallback(
    (report: boolean, current = latestForm.current) => {
      if (mode !== "create" || accountId === undefined || !draftReadyRef.current) return;
      if (canonicalForm(current) === initialSnapshot.current) {
        removeOpportunityDraft(accountId);
        if (report) setDraftStatus(null);
        return;
      }
      const saved = writeOpportunityDraft(accountId, current);
      if (report) {
        setDraftStatus(saved.ok ? { kind: "saved", savedAt: saved.savedAt } : { kind: "error" });
      }
    },
    [accountId, mode],
  );

  useLayoutEffect(() => {
    if (mode !== "create" || accountId === undefined) return;

    const stored = readOpportunityDraft(accountId);
    if (stored.kind === "draft") {
      setDraftPrompt(stored);
      setDraftStatus({ kind: "saved", savedAt: stored.savedAt });
    } else {
      draftReadyRef.current = true;
      setDraftReady(true);
      if (stored.kind === "error") setDraftStatus({ kind: "error" });
    }

    const beforeClear = () => {
      if (draftTimer.current !== undefined) window.clearTimeout(draftTimer.current);
      persistDraft(false);
      // `clearAllOpportunityDrafts()` now removes the just-flushed key. The form unmount cleanup
      // must not recreate it after logout invalidates the session.
      skipDraftCleanup.current = true;
    };
    window.addEventListener(BEFORE_DRAFTS_CLEARED_EVENT, beforeClear);

    return () => {
      window.removeEventListener(BEFORE_DRAFTS_CLEARED_EVENT, beforeClear);
      if (draftTimer.current !== undefined) window.clearTimeout(draftTimer.current);
      // Layout cleanup is synchronous: a normal route unmount cannot outrun the debounce and lose
      // the publisher's last keystrokes.
      if (!skipDraftCleanup.current) persistDraft(false);
    };
  }, [accountId, mode, persistDraft]);

  useEffect(() => {
    if (mode !== "create" || accountId === undefined || !draftReady) return;
    if (draftTimer.current !== undefined) window.clearTimeout(draftTimer.current);
    draftTimer.current = window.setTimeout(() => persistDraft(true, form), 500);
    return () => {
      if (draftTimer.current !== undefined) window.clearTimeout(draftTimer.current);
    };
  }, [accountId, draftReady, form, mode, persistDraft]);

  useLayoutEffect(() => {
    setBlocked(dirty && result === null);
    return () => setBlocked(false);
  }, [dirty, result, setBlocked]);

  useEffect(() => {
    if (!dirty || result) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
    // Browser Back/Forward is intentionally not trapped: App Router has no complete supported
    // blocker for it, and a popstate/history trap is brittle. Links and unloads are covered here.
  }, [dirty, result]);

  // The stored record is the BASE the edited fields are written over, not a set of leftovers
  // merged after the fact: a shallow merge cannot preserve the members of a container this form
  // only half models (see `toDocument`).
  // WHICH NAMESPACE THIS WRITE IS AUTHORISED AGAINST, which is a different question on a create and
  // a replace — see `namespaceAuthority`. It is derived from the STORED record rather than from the
  // id, because a claimed or imported listing keeps the id it arrived with.
  const writeAuthority = useMemo(
    () => namespaceAuthority(mode, form, carried),
    [mode, form, carried],
  );
  const built = useMemo(
    () => toDocument(form, carried, writeAuthority),
    [form, carried, writeAuthority],
  );
  const document = built.document;
  const validation = useMemo(() => validateDocument(document), [document]);

  const friendlyIssues: FormIssue[] = Object.entries(built.fieldProblems).map(
    ([path, message]) => ({ path, message, raw: message }),
  );
  const friendlyPaths = new Set(Object.keys(built.fieldProblems));
  const standardIssues: FormIssue[] = validation.available
    ? validation.issues
        .map((issue, index) =>
          mapValidationIssue(
            issue,
            validation.errors[index] ?? `${issue.path} ${issue.message}`,
            form.fundingType,
          ),
        )
        // Prefer the form's direct, task-specific wording when both validators found the same field.
        .filter((issue) => issue.path === null || !friendlyPaths.has(issue.path))
    : [];
  const localIssues = [...friendlyIssues, ...standardIssues];
  const localProblems = new Map(
    [...friendlyIssues, ...standardIssues]
      .filter((issue): issue is FormIssue & { path: string } => Boolean(issue.path))
      .map((issue) => [issue.path, issue.message]),
  );
  const serverProblems = new Map(
    serverIssues
      .filter((issue): issue is FormIssue & { path: string } => Boolean(issue.path))
      .map((issue) => [issue.path, issue.message]),
  );

  const touch = (path: string) =>
    setTouched((current) => (current.has(path) ? current : new Set(current).add(path)));

  /** The chrome every field shares: its path, its problem if that problem is due, its blur. */
  const at = (path: string) => ({
    path,
    problem:
      serverProblems.get(path) ??
      (attempted || touched.has(path) ? localProblems.get(path) : undefined),
    // Advice is not gated on having pressed anything. A problem shown early is a scolding; a
    // consequence shown early is the only version of it that can still change the answer.
    advisory: built.fieldAdvisories[path],
    onBlur: () => touch(path),
  });

  const set = <K extends keyof OpportunityFormState>(key: K, value: OpportunityFormState[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const setDetails = <K extends keyof DetailsState>(branch: K, patch: Partial<DetailsState[K]>) =>
    setForm((current) => ({
      ...current,
      details: { ...current.details, [branch]: { ...current.details[branch], ...patch } },
    }));

  /**
   * The id follows the title until somebody types over it.
   *
   * Derived rather than demanded, because the id is the one field on this form with no natural
   * answer and permanent consequences. It stays editable — a publisher who already has a key for
   * this programme should use it — and the moment they touch it, the derivation stops.
   */
  const derives = mode === "create";
  const retitle = (title: string) =>
    setForm((current) => ({
      ...current,
      title,
      id:
        derives && !current.idDirty
          ? deriveId(current.operatingOrganizations[0]?.slug ?? "", title)
          : current.id,
    }));

  /**
   * EVERY change to the operating organisations goes through here, and that is the point.
   *
   * The primary organisation names the namespace, and it changes on a move or a remove exactly as
   * surely as on a keystroke in row 0. An earlier version regenerated the derived id only on the
   * keystroke, so promoting another organisation left the id under the old namespace — and the
   * form's own error then told the publisher to do the thing they had just done.
   *
   * A hand-typed id is never touched: `idDirty` is the whole guard, and it is set the moment
   * somebody edits the field.
   */
  const withOperating = (update: (rows: OrganizationRow[]) => OrganizationRow[]) =>
    setForm((current) => {
      const operatingOrganizations = update(current.operatingOrganizations);
      return {
        ...current,
        operatingOrganizations,
        id:
          derives && !current.idDirty
            ? deriveId(operatingOrganizations[0]?.slug ?? "", current.title)
            : current.id,
      };
    });

  // On a replace the prediction is keyed to the stored publisher: the id is immutable and says
  // nothing about who may publish this listing.
  const consequence = describePublish(
    form.id,
    authority,
    mode === "edit" ? writeAuthority.namespace : undefined,
  );

  /**
   * The advisory tier, from both halves: this form's own advice about a field, and the validator's
   * check-tier findings. One list, because they are the same claim — the document is conformant and
   * something about it is still worth knowing — and neither ever blocks a submission.
   */
  const advisories = [...built.advisories, ...(validation.available ? validation.warnings : [])];

  const visibleIssues = [...(attempted ? localIssues : []), ...serverIssues];
  const technicalValidationLines = [
    ...new Set([
      ...(attempted && validation.available ? validation.errors : []),
      ...serverValidationLines,
    ]),
  ];

  const clearServerIssue = (path: string) => {
    const clearedLines = new Set(
      serverIssues.filter((issue) => issue.path === path).map((issue) => issue.raw),
    );
    if (clearedLines.size === 0) return;
    setServerIssues((current) => current.filter((issue) => issue.path !== path));
    setServerValidationLines((current) => current.filter((line) => !clearedLines.has(line)));
  };

  useEffect(() => {
    if (focusSummary === 0) return;
    errorSummaryRef.current?.focus();
  }, [focusSummary]);

  const send = async () => {
    setBusy(true);
    setNote(null);
    setServerIssues([]);
    setServerValidationLines([]);
    try {
      const response =
        mode === "create"
          ? await api.opportunities.create(document)
          : await api.opportunities.replace(form.id, document);
      if (mode === "create" && accountId !== undefined) {
        skipDraftCleanup.current = true;
        if (draftTimer.current !== undefined) window.clearTimeout(draftTimer.current);
        removeOpportunityDraft(accountId);
      }
      if (mode === "edit") initialSnapshot.current = canonicalForm(form);
      setResult(response);
    } catch (error) {
      if (error instanceof ApiError) {
        setServerIssues(issuesFromApi(error, form.fundingType));
        setServerValidationLines(error.details);
        setNote(actionErrorNote(error, "The submission could not be sent."));
      } else {
        setNote(actionErrorNote(error, "The submission could not be sent."));
      }
      setFocusSummary((current) => current + 1);
    } finally {
      setBusy(false);
    }
  };

  // The result REPLACES the form. Leaving a live Submit button under an outcome panel is how the
  // same opportunity gets submitted twice.
  if (result) {
    return (
      <SubmissionOutcome
        result={result}
        mode={mode}
        onAgain={() => {
          setResult(null);
          setNote(null);
          setServerIssues([]);
          setServerValidationLines([]);
          setAttempted(false);
          setTouched(new Set());
          if (mode === "create") {
            skipDraftCleanup.current = false;
            setForm(emptyForm());
          }
        }}
      />
    );
  }

  const details = form.details;

  return (
    <form
      className={styles.form}
      noValidate
      onChangeCapture={(event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        const path = target.closest<HTMLElement>("[data-field-path]")?.dataset.fieldPath;
        if (path) clearServerIssue(path);
      }}
      onSubmit={(event) => {
        event.preventDefault();
        setAttempted(true);
        // Pressing Submit is how a publisher asks what is wrong. It answers, and does not send.
        if (localIssues.length > 0) {
          setFocusSummary((current) => current + 1);
          return;
        }
        void send();
      }}
    >
      {draftPrompt ? (
        <div className="state">
          <p>
            <strong>Draft saved on this device</strong> on {formatInstant(draftPrompt.savedAt)}.
          </p>
          <p className="row">
            <button
              type="button"
              className="button-primary"
              onClick={() => {
                setForm(draftPrompt.form);
                setDraftPrompt(null);
                draftReadyRef.current = true;
                setDraftReady(true);
              }}
            >
              Restore draft
            </button>
            <button
              type="button"
              onClick={() => {
                if (accountId !== undefined && !removeOpportunityDraft(accountId)) {
                  setDraftStatus({ kind: "error" });
                } else {
                  setDraftStatus(null);
                }
                setDraftPrompt(null);
                draftReadyRef.current = true;
                setDraftReady(true);
              }}
            >
              Discard draft
            </button>
          </p>
        </div>
      ) : null}

      <p className={styles.requiredLegend}>
        <span aria-hidden="true">*</span> Required
      </p>

      <Section title="What is it">
        <TextField
          {...at("title")}
          required
          label="Title"
          hint="The name the programme is published under."
          maxLength={300}
          value={form.title}
          onChange={retitle}
        />
        <div className={styles.cols}>
          <SelectField
            {...at("fundingType")}
            required
            label="Funding type"
            hint={`Decides the details requested for this funding type below — currently ${DETAILS_SUFFIX[form.fundingType]}.`}
            options={FUNDING_TYPES}
            labels={LABELS}
            value={form.fundingType}
            onChange={(value) => set("fundingType", value as FundingType)}
          />
          <TextField
            {...at("summary")}
            className={styles.grow}
            label="Summary"
            optional
            hint="One or two sentences, for list and card views."
            maxLength={500}
            value={form.summary}
            onChange={(value) => set("summary", value)}
          />
        </div>
        <TextArea
          {...at("description")}
          required
          label="Description"
          hint="Markdown is permitted by the Standard. This frontend renders it as plain text everywhere, deliberately — see the README."
          rows={7}
          value={form.description}
          onChange={(value) => set("description", value)}
        />
      </Section>

      <Section title="Who runs it">
        <p className={styles.requiredLegend}>
          Running organisations <span aria-hidden="true">*</span>
        </p>
        <p className="hint">
          The organisations that actually run the intake — not necessarily who pays. The first one
          is the primary: it is the one displayed, and its slug is the namespace this listing
          publishes under.
        </p>
        <Repeatable
          name="operating organisations"
          rows={form.operatingOrganizations}
          addLabel="+ Add an operating organisation"
          onAdd={() => withOperating((rows) => [...rows, emptyOrganization()])}
          onRemove={(index) => withOperating((rows) => removeRow(rows, index))}
          onMove={(index, direction) => withOperating((rows) => moveRow(rows, index, direction))}
          rowLabel={(row, index) =>
            index === 0 ? "Primary organisation" : row.name.trim() || `Organisation ${index + 1}`
          }
        >
          {(row, index) => (
            <OrganizationFields
              row={row}
              prefix={`operatingOrganizations.${index}`}
              at={at}
              onChange={(next) => withOperating((rows) => replaceRow(rows, index, next))}
            />
          )}
        </Repeatable>
        {at("operatingOrganizations").problem ? (
          <span className={styles.problem}>{at("operatingOrganizations").problem}</span>
        ) : null}

        <p className="hint">
          Sponsoring organisations issue or back the opportunity. Leave this empty when the operator
          is the only party to name.
        </p>
        <Repeatable
          name="sponsoring organisations"
          rows={form.sponsoringOrganizations}
          addLabel="+ Add a sponsoring organisation"
          emptyLabel="No sponsoring organisation named."
          onAdd={() =>
            set("sponsoringOrganizations", [...form.sponsoringOrganizations, emptyOrganization()])
          }
          onRemove={(index) =>
            set("sponsoringOrganizations", removeRow(form.sponsoringOrganizations, index))
          }
          rowLabel={(row, index) => row.name.trim() || `Sponsor ${index + 1}`}
        >
          {(row, index) => (
            <OrganizationFields
              row={row}
              prefix={`sponsoringOrganizations.${index}`}
              at={at}
              onChange={(next) =>
                set(
                  "sponsoringOrganizations",
                  replaceRow(form.sponsoringOrganizations, index, next),
                )
              }
            />
          )}
        </Repeatable>
      </Section>

      <Section title="Identity">
        <TextField
          {...at("id")}
          required
          label={
            mode === "edit" ? (
              <>
                Id <span className="muted">— set when this listing was created</span>
              </>
            ) : (
              <>
                Id <span className="muted">— permanent, cannot be changed later</span>
              </>
            )
          }
          hint={
            mode === "edit"
              ? "An id is immutable. Everything that has ever linked to this listing links to this string."
              : "Proposed from the primary organisation's slug and the title. Edit it if you already have a key for this programme."
          }
          readOnly={mode === "edit"}
          maxLength={128}
          value={form.id}
          onChange={(value) => setForm((current) => ({ ...current, id: value, idDirty: true }))}
        />
        {consequence ? (
          <p
            className={[
              "callout",
              styles.consequence,
              consequence.immediate === true ? styles.consequenceNow : undefined,
              consequence.immediate === false ? styles.consequenceLater : undefined,
            ]
              .filter(Boolean)
              .join(" ")}
          >
            Publishes as <code>{consequence.id}</code> —{" "}
            <strong>
              {consequence.immediate === true
                ? "immediately, without review"
                : consequence.immediate === false
                  ? "pending, until a reviewer approves it"
                  : "immediately or pending"}
            </strong>
            , because {consequence.because}
          </p>
        ) : null}
        <SelectField
          {...at("status")}
          required
          label="Status"
          hint="'upcoming' is also the value for a posting made before the intake opens — there is no draft status."
          options={STATUSES}
          labels={LABELS}
          value={form.status}
          onChange={(value) => set("status", value)}
        />
      </Section>

      <Section title="Funding information">
        <div className={`${styles.cols} ${styles.fundingGrid}`}>
          <TextField
            {...at("currency")}
            className={styles.narrow}
            label="Currency"
            optional
            hint="One currency for the whole listing — the reward table, milestones and prizes below all read it from here."
            maxLength={16}
            placeholder="USD"
            value={form.currency}
            onChange={(value) => set("currency", value)}
          />
          <NumberField
            {...at("budget")}
            label="Total budget"
            optional
            value={form.budget}
            onChange={(value) => set("budget", value)}
          />
          <NumberField
            {...at("allocated")}
            label="Committed"
            optional
            hint="What has been promised to date, not what has been paid."
            value={form.allocated}
            onChange={(value) => set("allocated", value)}
          />
        </div>
        <div className={`${styles.cols} ${styles.fundingGrid}`}>
          <NumberField
            {...at("minAward")}
            label="Min award"
            optional
            value={form.minAward}
            onChange={(value) => set("minAward", value)}
          />
          <NumberField
            {...at("maxAward")}
            label="Max award"
            optional
            value={form.maxAward}
            onChange={(value) => set("maxAward", value)}
          />
        </div>

        <p className="hint">
          Milestones, in sequence. Their order is the only thing that orders them.
        </p>
        <Repeatable
          name="milestones"
          rows={form.milestones}
          addLabel="+ Add a milestone"
          emptyLabel="No milestones."
          onAdd={() => set("milestones", [...form.milestones, emptyMilestone()])}
          onRemove={(index) => set("milestones", removeRow(form.milestones, index))}
          onMove={(index, direction) =>
            set("milestones", moveRow(form.milestones, index, direction))
          }
          rowLabel={(row, index) => row.title.trim() || `Milestone ${index + 1}`}
        >
          {(row, index) => (
            <MilestoneFields
              row={row}
              index={index}
              at={at}
              onChange={(next) => set("milestones", replaceRow(form.milestones, index, next))}
            />
          )}
        </Repeatable>
      </Section>

      <Section title="Deadlines and dates">
        <div className={styles.cols}>
          <MomentField
            {...at("opensAt")}
            label="Applications open"
            optional
            value={form.opensAt}
            onChange={(value) => set("opensAt", value)}
          />
          <MomentField
            {...at("postedAt")}
            label="First announced"
            optional
            value={form.postedAt}
            onChange={(value) => set("postedAt", value)}
          />
        </div>
        <p className="hint">
          Every deadline is a fixed point in time or an open-ended rolling window. Label them: a
          consumer picks the application deadline out by its label, not by its position.
        </p>
        <Repeatable
          name="deadlines"
          rows={form.deadlines}
          addLabel="+ Add a deadline"
          emptyLabel="No deadlines. A programme with none states no closing date at all."
          onAdd={() => set("deadlines", [...form.deadlines, emptyDeadline()])}
          onRemove={(index) => set("deadlines", removeRow(form.deadlines, index))}
          rowLabel={(row, index) => row.label.trim() || `Deadline ${index + 1}`}
        >
          {(row, index) => (
            <DeadlineFields
              row={row}
              index={index}
              at={at}
              onChange={(next) => set("deadlines", replaceRow(form.deadlines, index, next))}
            />
          )}
        </Repeatable>
      </Section>

      <Section title="Reach and references">
        <div className={styles.cols}>
          <TextField
            {...at("ecosystems")}
            label="Ecosystems"
            optional
            hint="Comma-separated. Open list — no registry gate."
            value={form.ecosystems}
            onChange={(value) => set("ecosystems", value)}
          />
          <TextField
            {...at("categories")}
            label="Categories"
            optional
            hint="Comma-separated, free text."
            value={form.categories}
            onChange={(value) => set("categories", value)}
          />
        </div>
        <TextArea
          {...at("eligibility")}
          label="Eligibility"
          optional
          hint="Who may apply, in your own words. Deliberately not structured data."
          rows={3}
          value={form.eligibility}
          onChange={(value) => set("eligibility", value)}
        />
        <TextArea
          {...at("prerequisites")}
          label="Prerequisites"
          optional
          hint="What a proposal must CONTAIN to be considered — distinct from what the work must deliver."
          rows={3}
          value={form.prerequisites}
          onChange={(value) => set("prerequisites", value)}
        />
        <TextArea
          {...at("additionalReferences")}
          label="Additional references"
          optional
          hint="Guidelines, past rounds, forum threads, the original posting. One free-form block — paste what you have."
          rows={3}
          value={form.additionalReferences}
          onChange={(value) => set("additionalReferences", value)}
        />
        <TextArea
          {...at("serviceAgreement")}
          label="Service agreement"
          optional
          hint="Fill this in only for a long-term service engagement. Its presence is the signal; duration and renewal live in the text."
          rows={3}
          value={form.serviceAgreement}
          onChange={(value) => set("serviceAgreement", value)}
        />
        <div className={styles.cols}>
          <TextField
            {...at("applicationUrl")}
            className={styles.grow}
            label="Application URL"
            optional
            type="url"
            hint="The one link back to the opportunity itself, and the target of the source check."
            value={form.applicationUrl}
            onChange={(value) => set("applicationUrl", value)}
          />
          <TextField
            {...at("website")}
            className={styles.grow}
            label="Website"
            optional
            type="url"
            value={form.website}
            onChange={(value) => set("website", value)}
          />
        </div>
        <div className={styles.cols}>
          <TextField
            {...at("logoUrl")}
            label="Logo URL"
            optional
            type="url"
            value={form.logoUrl}
            onChange={(value) => set("logoUrl", value)}
          />
          <TextField
            {...at("bannerUrl")}
            label="Banner URL"
            optional
            type="url"
            value={form.bannerUrl}
            onChange={(value) => set("bannerUrl", value)}
          />
        </div>
        <p className="hint">
          Social and community links, one per URL. The same platform may appear more than once.
        </p>
        <Repeatable
          name="social links"
          rows={form.socialLinks}
          addLabel="+ Add a link"
          emptyLabel="No social links."
          onAdd={() => set("socialLinks", [...form.socialLinks, emptySocialLink()])}
          onRemove={(index) => set("socialLinks", removeRow(form.socialLinks, index))}
          rowLabel={(row, index) => row.platform || `Link ${index + 1}`}
        >
          {(row, index) => (
            <SocialLinkFields
              row={row}
              index={index}
              at={at}
              onChange={(next) => set("socialLinks", replaceRow(form.socialLinks, index, next))}
            />
          )}
        </Repeatable>
      </Section>

      <Section title={detailsTitle(form.fundingType)}>
        {form.fundingType === "grant" ? (
          <>
            <CheckList
              path="details.grant.fundingMechanisms"
              legend="Funding mechanisms"
              optional
              hint="More than one is normal: a funder can offer a fixed grant and a matching grant in the same programme."
              options={FUNDING_MECHANISMS}
              selected={details.grant.fundingMechanisms}
              onChange={(fundingMechanisms) => setDetails("grant", { fundingMechanisms })}
            />
            <SuggestField
              {...at("details.grant.programModel")}
              label="Programme model"
              optional
              hint="The operating model, as distinct from the funding instrument. The listed values are conventional, not exhaustive — your own is valid."
              options={PROGRAM_MODELS}
              value={details.grant.programModel}
              onChange={(programModel) => setDetails("grant", { programModel })}
            />
            <div className={styles.cols}>
              <TriField2
                {...at("details.grant.milestoneBased")}
                label="Paid against milestones"
                optional
                value={details.grant.milestoneBased}
                onChange={(milestoneBased) => setDetails("grant", { milestoneBased })}
              />
              <TriField2
                {...at("details.grant.recurring")}
                label="Runs in recurring rounds"
                optional
                value={details.grant.recurring}
                onChange={(recurring) => setDetails("grant", { recurring })}
              />
            </div>
          </>
        ) : null}

        {form.fundingType === "hackathon" ? (
          <>
            <CheckField
              path="details.hackathon.fullyOnline"
              label="Fully online — there is no physical location"
              hint="This is a claim, not a blank: it stores an explicit 'no location' rather than leaving the question unanswered."
              checked={details.hackathon.fullyOnline}
              onChange={(fullyOnline) => setDetails("hackathon", { fullyOnline })}
            />
            {details.hackathon.fullyOnline ? null : (
              <TextField
                {...at("details.hackathon.location")}
                label="Location"
                optional
                value={details.hackathon.location}
                onChange={(location) => setDetails("hackathon", { location })}
              />
            )}
            <div className={styles.cols}>
              <TriField2
                {...at("details.hackathon.online")}
                label="Also held online"
                value={details.hackathon.online}
                onChange={(online) => setDetails("hackathon", { online })}
              />
              <TextField
                {...at("details.hackathon.tracks")}
                className={styles.grow}
                label="Tracks"
                optional
                hint="Comma-separated."
                value={details.hackathon.tracks}
                onChange={(tracks) => setDetails("hackathon", { tracks })}
              />
            </div>
            <div className={styles.cols}>
              <NumberField
                {...at("details.hackathon.teamMin")}
                label="Smallest team"
                value={details.hackathon.teamMin}
                onChange={(teamMin) => setDetails("hackathon", { teamMin })}
              />
              <NumberField
                {...at("details.hackathon.teamMax")}
                label="Largest team"
                value={details.hackathon.teamMax}
                onChange={(teamMax) => setDetails("hackathon", { teamMax })}
              />
            </div>
            <p className="hint">
              The prize pool, one entry per prize, in the currency set under Funding information.
              Identical prizes are fine — several equal track prizes are normal.
            </p>
            <Repeatable
              name="prizes"
              rows={details.hackathon.prizes}
              addLabel="+ Add a prize"
              emptyLabel="No prizes listed."
              onAdd={() =>
                setDetails("hackathon", { prizes: [...details.hackathon.prizes, emptyPrize()] })
              }
              onRemove={(index) =>
                setDetails("hackathon", { prizes: removeRow(details.hackathon.prizes, index) })
              }
              rowLabel={(row, index) => row.track.trim() || `Prize ${index + 1}`}
            >
              {(row, index) => (
                <PrizeFields
                  row={row}
                  index={index}
                  at={at}
                  onChange={(next) =>
                    setDetails("hackathon", {
                      prizes: replaceRow(details.hackathon.prizes, index, next),
                    })
                  }
                />
              )}
            </Repeatable>
          </>
        ) : null}

        {form.fundingType === "bounty" ? (
          <BountyDetails details={details} at={at} setDetails={setDetails} />
        ) : null}

        {form.fundingType === "accelerator" ? (
          <>
            <div className={styles.cols}>
              <NumberField
                {...at("details.accelerator.programDurationWeeks")}
                label="Duration (weeks)"
                value={details.accelerator.programDurationWeeks}
                onChange={(programDurationWeeks) =>
                  setDetails("accelerator", { programDurationWeeks })
                }
              />
              <NumberField
                {...at("details.accelerator.batchSize")}
                label="Teams per cohort"
                value={details.accelerator.batchSize}
                onChange={(batchSize) => setDetails("accelerator", { batchSize })}
              />
              <NumberField
                {...at("details.accelerator.funding")}
                label="Funding per team"
                value={details.accelerator.funding}
                onChange={(funding) => setDetails("accelerator", { funding })}
              />
            </div>
            <div className={styles.cols}>
              <TextField
                {...at("details.accelerator.equity")}
                label="Equity taken"
                optional
                hint="Free text — programmes state this in incomparable ways."
                placeholder="up to 7% SAFE"
                value={details.accelerator.equity}
                onChange={(equity) => setDetails("accelerator", { equity })}
              />
              <SelectField
                {...at("details.accelerator.stage")}
                label="Stage targeted"
                optional
                options={ACCELERATOR_STAGES}
                blank="not stated"
                value={details.accelerator.stage}
                onChange={(stage) => setDetails("accelerator", { stage })}
              />
            </div>
            <CheckField
              path="details.accelerator.fullyRemote"
              label="Fully remote — there is no physical location"
              hint="Stores an explicit 'no location' rather than leaving the question unanswered."
              checked={details.accelerator.fullyRemote}
              onChange={(fullyRemote) => setDetails("accelerator", { fullyRemote })}
            />
            {details.accelerator.fullyRemote ? null : (
              <TextField
                {...at("details.accelerator.location")}
                label="Location"
                optional
                value={details.accelerator.location}
                onChange={(location) => setDetails("accelerator", { location })}
              />
            )}
            <TriField2
              {...at("details.accelerator.online")}
              label="Also run remotely"
              value={details.accelerator.online}
              onChange={(online) => setDetails("accelerator", { online })}
            />
          </>
        ) : null}

        {form.fundingType === "vc_fund" ? (
          <>
            <div className={styles.cols}>
              <NumberField
                {...at("details.vc_fund.checkMin")}
                label="Smallest cheque"
                value={details.vc_fund.checkMin}
                onChange={(checkMin) => setDetails("vc_fund", { checkMin })}
              />
              <NumberField
                {...at("details.vc_fund.checkMax")}
                label="Largest cheque"
                value={details.vc_fund.checkMax}
                onChange={(checkMax) => setDetails("vc_fund", { checkMax })}
              />
            </div>
            <CheckList
              path="details.vc_fund.stages"
              legend="Stages"
              options={VC_STAGES}
              selected={details.vc_fund.stages}
              onChange={(stages) => setDetails("vc_fund", { stages })}
            />
            <TextArea
              {...at("details.vc_fund.thesis")}
              label="Thesis"
              optional
              rows={3}
              value={details.vc_fund.thesis}
              onChange={(thesis) => setDetails("vc_fund", { thesis })}
            />
            <TextArea
              {...at("details.vc_fund.portfolio")}
              label="Portfolio"
              optional
              hint="One company per line."
              rows={3}
              value={details.vc_fund.portfolio}
              onChange={(portfolio) => setDetails("vc_fund", { portfolio })}
            />
            <div className={styles.cols}>
              <SelectField
                {...at("details.vc_fund.contactMethod")}
                label="How to approach"
                optional
                hint="'intro-only' means a warm introduction is required."
                options={CONTACT_METHODS}
                labels={LABELS}
                blank="not stated"
                value={details.vc_fund.contactMethod}
                onChange={(contactMethod) => setDetails("vc_fund", { contactMethod })}
              />
              <TriField2
                {...at("details.vc_fund.activelyInvesting")}
                label="Currently deploying capital"
                value={details.vc_fund.activelyInvesting}
                onChange={(activelyInvesting) => setDetails("vc_fund", { activelyInvesting })}
              />
            </div>
          </>
        ) : null}

        {form.fundingType === "rfp" ? (
          <>
            <TextArea
              {...at("details.rfp.scope")}
              label="Scope of work"
              optional
              hint="In-scope and out-of-scope prose both live here — one field, deliberately."
              rows={5}
              value={details.rfp.scope}
              onChange={(scope) => setDetails("rfp", { scope })}
            />
            <TextArea
              {...at("details.rfp.requirements")}
              label="Requirements"
              optional
              hint="What the WORK must deliver, one per line. What a proposal must contain goes in Prerequisites above."
              rows={5}
              value={details.rfp.requirements}
              onChange={(requirements) => setDetails("rfp", { requirements })}
            />
          </>
        ) : null}
      </Section>

      {!validation.available ? <p className="callout note error">{validation.reason}</p> : null}

      {visibleIssues.length > 0 ? (
        <div
          className="callout state error"
          role="alert"
          id={ERROR_SUMMARY_ID}
          ref={errorSummaryRef}
          tabIndex={-1}
        >
          <p>
            <strong>
              {serverIssues.length > 0
                ? "We couldn’t submit this listing."
                : "Fix these fields before submitting."}
            </strong>{" "}
            Linked items go to their field.
          </p>
          <ul>
            {visibleIssues.map((issue, index) => {
              const label = issueLabel(issue.path);
              const target =
                issue.path === "(root)"
                  ? ERROR_SUMMARY_ID
                  : issue.path
                    ? fieldId(issue.path)
                    : null;
              const copy = label ? `${label}: ${issue.message}` : issue.message;
              return (
                <li key={`${issue.raw}-${index}`}>
                  {target ? <a href={`#${target}`}>{copy}</a> : copy}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {advisories.length > 0 ? (
        <div className="state">
          <p>
            <strong>Things to review</strong> — these notes do not block submission.
          </p>
          <ul>
            {advisories.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {technicalValidationLines.length > 0 ? (
        <details>
          <summary>Technical validation details</summary>
          <ul>
            {technicalValidationLines.map((line) => (
              <li key={line}>
                <code>{line}</code>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <div className={styles.submitBar}>
        {/*
         * The one filled button on this screen, and the same one the rest of the site uses. The
         * global class rather than a copy of its declarations: a second definition of the primary
         * action is a second thing to remember when the accent changes.
         */}
        <button type="submit" className="button-primary" disabled={busy}>
          {busy ? "Sending…" : mode === "create" ? "Submit" : "Replace"}
        </button>
        {mode === "edit" ? (
          <GuardedLink href={`/listings/${encodeURIComponent(form.id)}`}>Cancel</GuardedLink>
        ) : null}
        <span className="muted footnote">
          Conformance is checked as you type; problems appear next to their field.
        </span>
        {mode === "create" && !draftPrompt && draftStatus?.kind === "saved" ? (
          <span className="muted footnote">
            Draft saved on this device · {formatInstant(draftStatus.savedAt)}
          </span>
        ) : null}
        {mode === "create" && draftStatus?.kind === "error" ? (
          <span className="callout note error">
            Draft saving is unavailable in this browser. Keep this page open until you submit.
          </span>
        ) : null}
        <ActionNote note={note} />
      </div>
    </form>
  );
}

// ── the pieces, one per repeating row ───────────────────────────────────────────

type Chrome = (path: string) => {
  path: string;
  problem?: string;
  advisory?: string;
  onBlur: () => void;
};

function OrganizationFields({
  row,
  prefix,
  at,
  onChange,
}: {
  row: OrganizationRow;
  prefix: string;
  at: Chrome;
  onChange: (row: OrganizationRow) => void;
}) {
  return (
    <>
      <div className={styles.cols}>
        <TextField
          {...at(`${prefix}.name`)}
          required
          className={styles.grow}
          label="Name"
          maxLength={256}
          value={row.name}
          onChange={(name) => onChange({ ...row, name })}
        />
        <TextField
          {...at(`${prefix}.slug`)}
          required
          label="Slug"
          hint="Lowercase, URL-safe. Also this organisation's namespace."
          value={row.slug}
          onChange={(slug) => onChange({ ...row, slug })}
        />
      </div>
      <div className={styles.cols}>
        <SelectField
          {...at(`${prefix}.orgType`)}
          label="Organisation kind"
          optional
          options={ORG_TYPES}
          blank="not stated"
          value={row.orgType}
          onChange={(orgType) => onChange({ ...row, orgType })}
        />
        <TextField
          {...at(`${prefix}.website`)}
          className={styles.grow}
          label="Website"
          optional
          type="url"
          value={row.website}
          onChange={(website) => onChange({ ...row, website })}
        />
      </div>
    </>
  );
}

function MilestoneFields({
  row,
  index,
  at,
  onChange,
}: {
  row: MilestoneRow;
  index: number;
  at: Chrome;
  onChange: (row: MilestoneRow) => void;
}) {
  return (
    <>
      <div className={styles.cols}>
        <TextField
          {...at(`milestones.${index}.title`)}
          className={styles.grow}
          label="Title"
          optional
          value={row.title}
          onChange={(title) => onChange({ ...row, title })}
        />
        <NumberField
          {...at(`milestones.${index}.amount`)}
          label="Amount"
          value={row.amount}
          onChange={(amount) => onChange({ ...row, amount })}
        />
      </div>
      <TextArea
        {...at(`milestones.${index}.criteria`)}
        label="Acceptance criteria"
        optional
        hint="Including any due date — a milestone has no date field of its own."
        rows={2}
        value={row.criteria}
        onChange={(criteria) => onChange({ ...row, criteria })}
      />
    </>
  );
}

function DeadlineFields({
  row,
  index,
  at,
  onChange,
}: {
  row: DeadlineRow;
  index: number;
  at: Chrome;
  onChange: (row: DeadlineRow) => void;
}) {
  return (
    <div className={styles.cols}>
      <SelectField
        {...at(`deadlines.${index}.deadlineType`)}
        required
        label="Deadline kind"
        options={DEADLINE_TYPES}
        labels={LABELS}
        value={row.deadlineType}
        onChange={(value) =>
          // Switching to rolling CLEARS the date rather than hiding it: a rolling deadline that
          // still carried one would be describing a point in time it does not have.
          onChange({
            ...row,
            deadlineType: value === "rolling" ? "rolling" : "fixed",
            date: value === "rolling" ? "" : row.date,
          })
        }
      />
      {row.deadlineType === "fixed" ? (
        <MomentField
          {...at(`deadlines.${index}.date`)}
          required
          label="Date"
          value={row.date}
          onChange={(date) => onChange({ ...row, date })}
        />
      ) : (
        <div className="field">
          <p className="hint">
            Rolling — applications are accepted continuously, so there is no date.
          </p>
        </div>
      )}
      <SuggestField
        {...at(`deadlines.${index}.label`)}
        label="Label"
        optional
        hint="How a consumer tells this from the others."
        options={DEADLINE_LABELS}
        value={row.label}
        onChange={(label) => onChange({ ...row, label })}
      />
    </div>
  );
}

function SocialLinkFields({
  row,
  index,
  at,
  onChange,
}: {
  row: SocialLinkRow;
  index: number;
  at: Chrome;
  onChange: (row: SocialLinkRow) => void;
}) {
  return (
    <div className={styles.cols}>
      <SelectField
        {...at(`socialLinks.${index}.platform`)}
        required
        label="Platform"
        options={SOCIAL_PLATFORMS}
        value={row.platform}
        onChange={(platform) => onChange({ ...row, platform })}
      />
      <TextField
        {...at(`socialLinks.${index}.url`)}
        required
        className={styles.grow}
        label="URL"
        type="url"
        hint="A link, not a handle."
        value={row.url}
        onChange={(url) => onChange({ ...row, url })}
      />
    </div>
  );
}

function PrizeFields({
  row,
  index,
  at,
  onChange,
}: {
  row: PrizeRow;
  index: number;
  at: Chrome;
  onChange: (row: PrizeRow) => void;
}) {
  return (
    <div className={styles.cols}>
      <TextField
        {...at(`details.hackathon.prizes.${index}.track`)}
        className={styles.grow}
        label="Track"
        optional
        value={row.track}
        onChange={(track) => onChange({ ...row, track })}
      />
      <NumberField
        {...at(`details.hackathon.prizes.${index}.amount`)}
        required
        label="Amount"
        value={row.amount}
        onChange={(amount) => onChange({ ...row, amount })}
      />
    </div>
  );
}

/**
 * The bounty branch, which carries the standard's most conditional corner.
 *
 * TWO RULES, both enforced by clearing rather than hiding. A security bounty is forbidden a single
 * `reward` outright and must state a table; a task bounty states EXACTLY ONE of the two, because
 * the pair are alternative descriptions of the same money and a document carrying both leaves a
 * consumer no way to tell which is authoritative. Switching either control therefore changes what
 * the document contains, not just what the screen shows.
 */
function BountyDetails({
  details,
  at,
  setDetails,
}: {
  details: DetailsState;
  at: Chrome;
  setDetails: <K extends keyof DetailsState>(branch: K, patch: Partial<DetailsState[K]>) => void;
}) {
  const bounty = details.bounty;
  const tiers = bounty.bountyKind === "security" || bounty.rewardMode === "tiers";

  return (
    <>
      <div className={styles.cols}>
        <SelectField
          {...at("details.bounty.bountyKind")}
          required
          label="Bounty kind"
          hint="Security bounties always pay against a reward table. A task bounty offers a single reward or a table — never both."
          options={BOUNTY_KINDS}
          labels={LABELS}
          value={bounty.bountyKind}
          onChange={(value) =>
            setDetails("bounty", {
              bountyKind: value === "security" ? "security" : "task",
              rewardMode: value === "security" ? "tiers" : bounty.rewardMode,
            })
          }
        />
        <TextField
          {...at("details.bounty.platform")}
          label="Platform"
          optional
          hint="Where the bounty is hosted, if it is."
          value={bounty.platform}
          onChange={(platform) => setDetails("bounty", { platform })}
        />
        <SelectField
          {...at("details.bounty.rewardPoolStatus")}
          label="Reward pool"
          optional
          hint="'unknown' is the honest value where the programme says nothing."
          options={REWARD_POOL_STATUSES}
          labels={LABELS}
          blank="not stated"
          value={bounty.rewardPoolStatus}
          onChange={(rewardPoolStatus) => setDetails("bounty", { rewardPoolStatus })}
        />
      </div>

      {bounty.bountyKind === "task" ? (
        <>
          <SelectField
            {...at("details.bounty.rewardMode")}
            required
            label="Compensation"
            hint="Exactly one of the two. Switching removes the other from the document — they are alternative descriptions of the same money."
            options={["single", "tiers"]}
            labels={LABELS}
            value={bounty.rewardMode}
            onChange={(value) =>
              setDetails("bounty", { rewardMode: value === "tiers" ? "tiers" : "single" })
            }
          />
          <div className={styles.cols}>
            <SelectField
              {...at("details.bounty.difficulty")}
              label="Difficulty"
              optional
              options={DIFFICULTIES}
              blank="not stated"
              value={bounty.difficulty}
              onChange={(difficulty) => setDetails("bounty", { difficulty })}
            />
            <TextField
              {...at("details.bounty.skills")}
              className={styles.grow}
              label="Skills"
              optional
              hint="Comma-separated, free text."
              value={bounty.skills}
              onChange={(skills) => setDetails("bounty", { skills })}
            />
          </div>
        </>
      ) : (
        <TextField
          {...at("details.bounty.severityScheme")}
          label="Severity scheme"
          optional
          hint="Whose definition of 'critical' is in play. Free text — these are documents, not a vocabulary."
          value={bounty.severityScheme}
          onChange={(severityScheme) => setDetails("bounty", { severityScheme })}
        />
      )}

      {tiers ? (
        <RewardTable
          rows={bounty.rewardTiers}
          at={at}
          tableProblem={at("details.bounty.rewardTiers").problem}
          onChange={(rewardTiers) => setDetails("bounty", { rewardTiers })}
        />
      ) : (
        <NumberField
          {...at("details.bounty.reward")}
          required
          label="Reward"
          hint="Paid on completion, in the currency set under Funding information."
          value={bounty.reward}
          onChange={(reward) => setDetails("bounty", { reward })}
        />
      )}
    </>
  );
}

function RewardTable({
  rows,
  at,
  tableProblem,
  onChange,
}: {
  rows: RewardTierRow[];
  at: Chrome;
  tableProblem?: string;
  onChange: (rows: RewardTierRow[]) => void;
}) {
  return (
    <div className="field">
      <span className={styles.itemName}>Reward table</span>
      <div className={styles.tableScroll}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">Severity</th>
              <th scope="col">Asset type</th>
              <th scope="col">Label</th>
              <th scope="col">Payout model</th>
              <th scope="col">Amounts</th>
              <th scope="col">
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => {
              const base = `details.bounty.rewardTiers.${index}`;
              const update = (next: RewardTierRow) => onChange(replaceRow(rows, index, next));
              return (
                <tr key={row.key}>
                  <td>
                    <SuggestField
                      {...at(`${base}.severity`)}
                      label={<span className="visually-hidden">Severity, tier {index + 1}</span>}
                      options={BOUNTY_SEVERITIES}
                      value={row.severity}
                      onChange={(severity) => update({ ...row, severity })}
                    />
                  </td>
                  <td>
                    <SuggestField
                      {...at(`${base}.assetType`)}
                      label={<span className="visually-hidden">Asset type, tier {index + 1}</span>}
                      options={BOUNTY_ASSET_TYPES}
                      value={row.assetType}
                      onChange={(assetType) => update({ ...row, assetType })}
                    />
                  </td>
                  <td>
                    <TextField
                      {...at(`${base}.label`)}
                      label={<span className="visually-hidden">Label, tier {index + 1}</span>}
                      value={row.label}
                      onChange={(label) => update({ ...row, label })}
                    />
                  </td>
                  <td>
                    <SelectField
                      {...at(`${base}.payout.model`)}
                      required
                      label={
                        <span className="visually-hidden">Payout model, tier {index + 1}</span>
                      }
                      options={PAYOUT_MODELS}
                      labels={LABELS}
                      value={row.payout.model}
                      onChange={(value) =>
                        // Clearing, not hiding: the schema false-forbids the amounts the new model
                        // does not use, so a stray one is a hard validation failure.
                        update({
                          ...row,
                          payout: {
                            ...row.payout,
                            model: value as PayoutModel,
                            amount: value === "fixed" ? row.payout.amount : "",
                            min: value === "range" ? row.payout.min : "",
                            max: value === "range" || value === "up_to" ? row.payout.max : "",
                            percent: value === "percentage" ? row.payout.percent : "",
                            floor: value === "percentage" ? row.payout.floor : "",
                            cap: value === "percentage" ? row.payout.cap : "",
                          },
                        })
                      }
                    />
                  </td>
                  <td>
                    <PayoutAmounts row={row} index={index} at={at} onChange={update} />
                  </td>
                  <td>
                    <button
                      type="button"
                      className={styles.small}
                      onClick={() => onChange(removeRow(rows, index))}
                    >
                      Remove<span className="visually-hidden"> tier {index + 1}</span>
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="hint">
        Switching a row&rsquo;s payout model clears the amounts that no longer apply — the Standard
        rejects stray ones. Each row also needs a severity, an asset type or a label: a row with no
        selector is a rule nothing can be matched against.
      </p>
      {tableProblem ? <span className={styles.problem}>{tableProblem}</span> : null}
      <button
        type="button"
        className={`${styles.small} ${styles.add}`}
        onClick={() => onChange([...rows, emptyRewardTier()])}
      >
        + Add a tier
      </button>
    </div>
  );
}

function PayoutAmounts({
  row,
  index,
  at,
  onChange,
}: {
  row: RewardTierRow;
  index: number;
  at: Chrome;
  onChange: (row: RewardTierRow) => void;
}) {
  const base = `details.bounty.rewardTiers.${index}.payout`;
  const payout = row.payout;
  const amount = (
    member: "amount" | "min" | "max" | "percent" | "floor" | "cap",
    label: string,
    required = false,
  ) => {
    const props = {
      ...at(`${base}.${member}`),
      label: (
        <span className="visually-hidden">
          {label}, tier {index + 1}
        </span>
      ),
      value: payout[member],
      onChange: (value: string) => onChange({ ...row, payout: { ...payout, [member]: value } }),
    };
    return required ? <NumberField {...props} required /> : <NumberField {...props} />;
  };

  if (payout.model === "discretionary") {
    return <span className="muted">Decided case by case — no figure.</span>;
  }

  return (
    <div className={styles.amounts}>
      {payout.model === "fixed" ? amount("amount", "Amount", true) : null}
      {payout.model === "range" ? (
        <>
          {amount("min", "Lower bound", true)}
          <span aria-hidden="true">to</span>
          {amount("max", "Upper bound", true)}
        </>
      ) : null}
      {payout.model === "up_to" ? amount("max", "Ceiling", true) : null}
      {payout.model === "percentage" ? (
        <>
          {amount("percent", "Percentage", true)}
          <span aria-hidden="true">% of</span>
          <SelectField
            {...at(`${base}.basis`)}
            required
            label={<span className="visually-hidden">Basis, tier {index + 1}</span>}
            options={PAYOUT_BASES}
            labels={LABELS}
            value={payout.basis}
            onChange={(basis) => onChange({ ...row, payout: { ...payout, basis } })}
          />
          <label htmlFor={fieldId(`${base}.floor`)}>floor</label>
          {amount("floor", "Floor")}
          <label htmlFor={fieldId(`${base}.cap`)}>cap</label>
          {amount("cap", "Cap")}
        </>
      ) : null}
    </div>
  );
}

// ── two thin wrappers, for the shapes used everywhere ───────────────────────────

/** An amount or count input: right-aligned, decimal keypad, and never `type="number"` — see below. */
function NumberField(
  props: FieldChrome & {
    value: string;
    onBlur?: () => void;
    onChange: (value: string) => void;
    className?: string;
  },
) {
  // `type="number"` silently discards a value the browser considers malformed, which means the
  // publisher's typo becomes an empty field and the form has nothing to complain about. Text plus
  // `inputMode` gets the numeric keypad without the data loss.
  return <TextField {...props} inputMode="decimal" className={props.className} />;
}

/** A local wall time, with the exact UTC instant visible before submission. */
function MomentField({
  value,
  onChange,
  onBlur,
  hint,
  ...chrome
}: FieldChrome & {
  value: string;
  onBlur?: () => void;
  onChange: (value: string) => void;
}) {
  const preview = utcPreview(value);
  const zone = localTimeZoneDescription(value);
  return (
    <Field
      {...chrome}
      hint={
        <>
          {hint ? <>{hint} </> : null}
          Enter local time ({zone}).
        </>
      }
    >
      {(control) => (
        <div className={styles.momentControl}>
          <input
            {...control}
            type="datetime-local"
            step={1}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onBlur={onBlur}
          />
          {preview ? <span className={styles.utcPreview}>{preview}</span> : null}
        </div>
      )}
    </Field>
  );
}

/** The three-state select. Named apart from the primitive so the import list stays readable. */
function TriField2(
  props: FieldChrome & {
    value: Tri;
    onChange: (value: Tri) => void;
    onBlur?: () => void;
  },
) {
  return (
    <Field {...props}>
      {(chrome) => (
        <select
          {...chrome}
          value={props.value}
          onChange={(event) => props.onChange(event.target.value as Tri)}
        >
          <option value="">not stated</option>
          <option value="yes">yes</option>
          <option value="no">no</option>
        </select>
      )}
    </Field>
  );
}

/**
 * What actually happened to the submission, in place of the form.
 *
 * `reviewStatus` and the duplicate check are the two things a publisher misreads if they are not
 * spelled out: a pending submission is stored and invisible, and an empty duplicate list means
 * "nothing similar" only when the check ran at all.
 */
function SubmissionOutcome({
  result,
  mode,
  onAgain,
}: {
  result: SubmissionResult;
  mode: "create" | "edit";
  onAgain: () => void;
}) {
  const [duplicatesAcknowledged, setDuplicatesAcknowledged] = useState(false);
  const source = { mergedInto: null, reviewStatus: result.reviewStatus, isListed: result.isListed };
  const status = publisherStatus(source);
  const hasPublicPage = result.reviewStatus === "approved" && result.isListed;
  const journey =
    mode === "create" && result.reviewStatus === "pending"
      ? { current: "review" as const, reviewSkipped: false }
      : mode === "create" && result.reviewStatus === "approved" && result.isListed
        ? { current: "live" as const, reviewSkipped: true }
        : null;
  return (
    <output className={`card ${styles.outcome}`}>
      <h2>{result.created ? "Submitted." : "Replaced."}</h2>
      {journey ? (
        <PublisherJourney current={journey.current} reviewSkipped={journey.reviewSkipped} />
      ) : null}
      <p className="lede">
        <strong>
          <UntrustedText value={result.opportunity.title} />
        </strong>
      </p>
      <p>
        <PublisherStatusBadge source={source} />
      </p>
      <p>
        {status === "live"
          ? "Published — it is in the public directory now."
          : status === "pending"
            ? "Stored as a pending submission. It is hidden from the public directory until a Hub reviewer approves it; publishing immediately requires membership of a verified organisation for this organisation prefix."
            : status === "hidden"
              ? "Approved, but hidden from the public directory."
              : status === "rejected"
                ? "Rejected — it is not in the public directory."
                : "Merged into another listing."}
      </p>
      {result.duplicates.length === 0 ? (
        <p>{describeDuplicateCheck(result.duplicateCheck, 0)}</p>
      ) : duplicatesAcknowledged ? (
        <p className="muted">
          Marked as a different programme on this screen. Reviewers will still see the possible
          match.
        </p>
      ) : (
        <section className={styles.duplicateWarning} aria-labelledby="duplicate-warning-heading">
          <div className={styles.duplicateWarningHeading}>
            <span aria-hidden="true">⚠</span>
            <h3 id="duplicate-warning-heading">Possible duplicate</h3>
          </div>
          <p>{describeDuplicateCheck(result.duplicateCheck, result.duplicates.length)}</p>
          <ul>
            {result.duplicates.map((match) => (
              <li key={match.id}>
                <strong>{formatSimilarity(match.similarity)}</strong> —{" "}
                <GuardedLink
                  href={`${match.isPublic ? "/opportunities" : "/listings"}/${encodeURIComponent(match.id)}`}
                >
                  <UntrustedText value={match.title} />
                </GuardedLink>{" "}
                <code>{match.id}</code>
              </li>
            ))}
          </ul>
          <p>
            {status === "pending"
              ? "A reviewer will compare the pair before publication."
              : "A reviewer will also see this match."}
          </p>
          <button type="button" onClick={() => setDuplicatesAcknowledged(true)}>
            This is a different programme
          </button>
        </section>
      )}
      {result.warnings.length > 0 ? (
        <>
          <p>
            <strong>Things to review:</strong>
          </p>
          <ul>
            {result.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </>
      ) : null}
      <p className="row">
        <GuardedLink
          className="button-primary"
          href={`/${hasPublicPage ? "opportunities" : "listings"}/${encodeURIComponent(result.opportunity.id)}`}
        >
          {hasPublicPage ? "View it as applicants see it" : "Open this listing"}
        </GuardedLink>
        <button type="button" onClick={onAgain}>
          {mode === "create" ? "Submit another" : "Continue editing"}
        </button>
      </p>
    </output>
  );
}
