"use client";

import { ConfirmPanel } from "@/components/Confirm";
import { UntrustedText } from "@/components/UntrustedText";
import { ActionNote, type ActionNoteValue, actionErrorNote } from "@/components/states";
import { useApi } from "@/lib/session";
import type { AccountSummary } from "@/lib/types";
import { useEffect, useId, useRef, useState } from "react";
import styles from "./SubmitterTransfer.module.css";

export function SubmitterTransfer({
  id,
  name,
  currentName,
  onTransferred,
}: {
  id: string;
  name: string;
  currentName: string | null;
  onTransferred: () => void;
}) {
  const api = useApi();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<ActionNoteValue | null>(null);
  const transfer = async () => {
    setBusy(true);
    setNote(null);
    try {
      await api.opportunities.assumeSubmission(id);
      setConfirming(false);
      setNote({ kind: "ok", message: "The program submission is now attributed to you." });
      onTransferred();
    } catch (error) {
      setNote(actionErrorNote(error, "Could not change the program's submitter."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {confirming ? (
        <ConfirmPanel
          title="Use your name as the program’s submitter?"
          confirmLabel="Use my name"
          busyLabel="Updating submitter…"
          busy={busy}
          onConfirm={() => void transfer()}
          onCancel={() => setConfirming(false)}
        >
          <p>
            The submission will be credited to <UntrustedText value={name} />
            {currentName ? (
              <>
                {" "}
                instead of <UntrustedText value={currentName} />
              </>
            ) : null}
            . The previous attribution stays in the history. Your organization’s authorized members
            keep their editing and analytics access.
          </p>
        </ConfirmPanel>
      ) : (
        <button
          type="button"
          onClick={() => {
            setNote(null);
            setConfirming(true);
          }}
        >
          Use my name as submitter
        </button>
      )}
      <ActionNote note={note} />
    </>
  );
}

/** Administrative attribution names the recipient; it never impersonates the recipient as actor. */
export function AdminSubmitterTransfer({
  id,
  currentName,
  currentAccountId,
  onTransferred,
}: {
  id: string;
  currentName: string | null;
  currentAccountId: number | null;
  onTransferred: () => void;
}) {
  const api = useApi();
  const fieldId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<AccountSummary[] | null>(null);
  const [selected, setSelected] = useState<AccountSummary | null>(null);
  const [reason, setReason] = useState("");
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [note, setNote] = useState<ActionNoteValue | null>(null);
  const generation = useRef(0);
  const searchInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open && !confirming) searchInput.current?.focus();
    return () => {
      generation.current += 1;
    };
  }, [open, confirming]);
  const search = async () => {
    const mine = ++generation.current;
    setSearching(true);
    setCandidates(null);
    setNote(null);
    try {
      const result = await api.review.accounts({ q: query.trim(), limit: 10 });
      if (generation.current === mine) setCandidates(result.items);
    } catch (error) {
      if (generation.current === mine)
        setNote(actionErrorNote(error, "Could not search accounts. Try again."));
    } finally {
      if (generation.current === mine) setSearching(false);
    }
  };
  const close = () => {
    generation.current += 1;
    setOpen(false);
    setConfirming(false);
    setSearching(false);
    setQuery("");
    setCandidates(null);
    setSelected(null);
    setReason("");
  };
  const transfer = async () => {
    if (!selected || !reason.trim() || busy) return;
    setBusy(true);
    setNote(null);
    try {
      await api.admin.assignSubmitter(id, { accountId: selected.id, reason: reason.trim() });
      close();
      setNote({ kind: "ok", message: "The program’s submitter has been updated." });
      onTransferred();
    } catch (error) {
      setNote(actionErrorNote(error, "Could not change the program’s submitter."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={styles.root}>
      {!open ? (
        <button
          type="button"
          onClick={() => {
            setNote(null);
            setOpen(true);
          }}
        >
          Change submitter
        </button>
      ) : confirming && selected ? (
        <ConfirmPanel
          title="Change this program’s submitter?"
          confirmLabel="Change submitter"
          busyLabel="Updating submitter…"
          busy={busy}
          onConfirm={() => void transfer()}
          onCancel={() => setConfirming(false)}
        >
          <p>
            <UntrustedText value={currentName} fallback="No submitter assigned" /> →{" "}
            <UntrustedText value={selected.handle ?? selected.displayName} /> (account {selected.id}
            ).
          </p>
          <p>
            The previous attribution and your reason will be saved in the history. The
            organization’s authorized members keep their access. This does not add organization
            membership.
          </p>
          <p>
            Reason: <UntrustedText value={reason.trim()} />
          </p>
        </ConfirmPanel>
      ) : (
        <fieldset className="card">
          <legend>Change submitter</legend>
          <p>
            Current submitter:{" "}
            <UntrustedText value={currentName} fallback="No submitter assigned" />
            {currentAccountId !== null ? ` (account ${currentAccountId})` : ""}.
          </p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void search();
            }}
          >
            <div className="field">
              <label htmlFor={`${fieldId}-search`}>Find an account</label>
              <input
                ref={searchInput}
                id={`${fieldId}-search`}
                value={query}
                maxLength={200}
                placeholder="Name, handle, email or account ID"
                disabled={searching}
                onChange={(event) => {
                  generation.current += 1;
                  setQuery(event.target.value);
                  setCandidates(null);
                  setSelected(null);
                }}
              />
            </div>
            <button type="submit" disabled={searching || !query.trim()}>
              {searching ? "Searching…" : "Search accounts"}
            </button>
          </form>
          {candidates ? (
            <div className="field">
              <label htmlFor={`${fieldId}-account`}>New submitter</label>
              {candidates.length === 0 ? (
                <output>No accounts matched. Try another name or handle.</output>
              ) : (
                <select
                  id={`${fieldId}-account`}
                  value={selected?.id ?? ""}
                  onChange={(event) =>
                    setSelected(
                      candidates.find((account) => account.id === Number(event.target.value)) ??
                        null,
                    )
                  }
                >
                  <option value="">Select an account</option>
                  {candidates.map((account) => (
                    <option
                      key={account.id}
                      value={account.id}
                      disabled={!(account.handle ?? account.displayName)?.trim()}
                    >
                      {account.handle ?? account.displayName ?? "Public name required"} — account{" "}
                      {account.id}
                      {account.email ? ` · ${account.email}` : ""}
                    </option>
                  ))}
                </select>
              )}
            </div>
          ) : null}
          <div className="field">
            <label htmlFor={`${fieldId}-reason`}>Reason for this change</label>
            <textarea
              id={`${fieldId}-reason`}
              value={reason}
              maxLength={1000}
              required
              onChange={(event) => setReason(event.target.value)}
            />
          </div>
          <p className="muted footnote">
            Changing attribution keeps team access. To give this person organization access, assign
            a publisher role through organization membership.
          </p>
          <div className="row">
            <button
              type="button"
              disabled={!selected || !reason.trim()}
              onClick={() => {
                setNote(null);
                setConfirming(true);
              }}
            >
              Review change
            </button>
            <button type="button" onClick={close}>
              Cancel
            </button>
          </div>
        </fieldset>
      )}
      <ActionNote note={note} />
    </div>
  );
}
