"use client";

/**
 * A CONSEQUENCE, STATED, BEFORE THE THING HAPPENS.
 *
 * Every use of this sits in front of an action that changes what the public can see or what an
 * account may do: publishing somebody's listing, refusing one, granting an organisation the right to
 * publish without review, merging two records into one. None of them is undoable by pressing the
 * button again.
 *
 * WHY A PANEL RATHER THAN `window.confirm`. A native dialog cannot say the thing that matters here.
 * The consequence is specific — WHICH organisation, HOW MANY members it arms, WHOSE name the
 * decision is recorded under — and it usually needs a second control beside it (a required reason).
 * A one-line browser prompt flattens all of that to "Are you sure?", which is the question nobody
 * has ever answered informatively. It is also unstyleable, unreadable to a screen reader in the way
 * the rest of this package is, and untestable.
 *
 * IT IS NOT A MODAL. Nothing is trapped and nothing is dimmed: the panel opens in place, under the
 * row it belongs to, so the reader can still see the thing they are deciding about while they read
 * what deciding will do. Cancel is a real button, not an X in a corner.
 */
import type { ReactNode } from "react";

export function ConfirmPanel({
  title,
  children,
  confirmLabel,
  busyLabel,
  busy,
  disabled,
  onConfirm,
  onCancel,
}: {
  /** Names the action AND its object — "Verify Indie Collective?", not "Are you sure?". */
  title: string;
  /** The consequence, in prose. This is the whole reason the panel exists. */
  children: ReactNode;
  confirmLabel: string;
  /** Shown while the request is in flight. Carries the U+2026 the rest of the package uses. */
  busyLabel: string;
  busy?: boolean;
  /** For a confirm that needs something first — a written reason, typically. */
  disabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    /*
     * A `<fieldset>` with a `<legend>`, not a div with `role="group"`. It is literally what this is
     * — a set of controls under one caption — and the native element carries the grouping to a
     * screen reader without an ARIA attribute standing in for markup that already exists.
     */
    <fieldset className="card card-strong confirm">
      <legend className="empty-title">{title}</legend>
      {children}
      <p className="row">
        <button
          type="button"
          className="button-primary"
          disabled={busy || disabled}
          onClick={onConfirm}
        >
          {busy ? busyLabel : confirmLabel}
        </button>
        <button type="button" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </p>
    </fieldset>
  );
}
