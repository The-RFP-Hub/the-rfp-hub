"use client";

/**
 * The form's building blocks: one input, one label, one hint, one problem.
 *
 * WHY THESE EXIST rather than a hundred hand-rolled `<div className="field">`s. Three things have
 * to be true of every single input on the submission form, and each of them is the kind of thing
 * that is right in ninety fields and forgotten in the ninety-first:
 *
 *   1. The label is FOR the input, and the hint and the problem are wired to it with
 *      `aria-describedby`. A hint that is only visually adjacent is not a hint to a screen reader.
 *   2. A field with a problem carries `aria-invalid`, so it is announced as wrong rather than
 *      merely followed by red text.
 *   3. The problem is shown only when it is due — after the field has been left, or after the
 *      publisher has pressed Submit. Marking an untouched empty required field red is telling
 *      somebody off for not having got there yet.
 *
 * Every one of those is a property of the pairing, not of the input, so the pairing is the
 * component. Ids are derived from the field's PATH (`deadlines.0.date`), which is the same string
 * the validation map is keyed on — so a problem cannot be attached to the wrong input without the
 * label breaking too.
 */
import styles from "@/components/OpportunityForm.module.css";
import type { ReactNode } from "react";

/** `deadlines.0.date` → `f-deadlines-0-date`. Stable, unique, and derived rather than typed. */
export function fieldId(path: string): string {
  return `f-${path.replace(/[^A-Za-z0-9]+/g, "-")}`;
}

export interface FieldChrome {
  path: string;
  label: ReactNode;
  hint?: ReactNode;
  /** The problem for this field, or nothing. Already filtered for "is it due yet". BLOCKING. */
  problem?: string;
  /**
   * Advice for this field. NEVER blocking, and never `aria-invalid` — it is the same tier as the
   * validator's advisory warnings, and a field carrying one is conformant.
   */
  advisory?: string;
  /** Rendered under the input, above the problem — the character counters live here. */
  meter?: ReactNode;
  /** Marks the label so a publisher can tell what they may leave alone. */
  optional?: boolean;
}

/**
 * The wiring, without the control.
 *
 * The control is a render prop rather than a `type` string because the set of controls is open —
 * `select`, `textarea`, a checkbox, a pair of number inputs in one cell — and a component that
 * enumerated them would be a worse `<input>`.
 */
export function Field({
  path,
  label,
  hint,
  problem,
  advisory,
  meter,
  optional,
  className,
  children,
}: FieldChrome & {
  className?: string;
  children: (props: {
    id: string;
    "aria-describedby": string | undefined;
    "aria-invalid": boolean | undefined;
    className: string | undefined;
  }) => ReactNode;
}) {
  const id = fieldId(path);
  const hintId = hint ? `${id}-hint` : undefined;
  const problemId = problem ? `${id}-problem` : undefined;
  const advisoryId = advisory ? `${id}-advisory` : undefined;
  const describedBy = [hintId, problemId, advisoryId].filter(Boolean).join(" ") || undefined;

  return (
    <div className={className ? `field ${className}` : "field"}>
      <label htmlFor={id}>
        {label}
        {optional ? <span className="muted"> — optional</span> : null}
      </label>
      {hint ? (
        <p className="hint" id={hintId}>
          {hint}
        </p>
      ) : null}
      {children({
        id,
        "aria-describedby": describedBy,
        "aria-invalid": problem ? true : undefined,
        className: problem ? styles.invalid : undefined,
      })}
      {meter}
      {problem ? (
        <span className={styles.problem} id={problemId}>
          {problem}
        </span>
      ) : null}
      {advisory ? (
        <span className={styles.advisory} id={advisoryId}>
          {advisory}
        </span>
      ) : null}
    </div>
  );
}

export function TextField({
  value,
  onChange,
  onBlur,
  placeholder,
  inputMode,
  type,
  readOnly,
  maxLength,
  ...chrome
}: FieldChrome & {
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  placeholder?: string;
  inputMode?: "decimal" | "numeric" | "text" | "url";
  type?: "text" | "url" | "datetime-local";
  readOnly?: boolean;
  /** The schema's own limit, shown as a counter. NOT enforced by the input — see below. */
  maxLength?: number;
  className?: string;
}) {
  const over = maxLength !== undefined && value.trim().length > maxLength;
  return (
    <Field
      {...chrome}
      meter={
        maxLength === undefined ? undefined : (
          <span className={over ? `${styles.counter} ${styles.counterOver}` : styles.counter}>
            {value.trim().length} / {maxLength}
          </span>
        )
      }
    >
      {(props) => (
        <input
          {...props}
          className={[props.className, readOnly ? styles.frozen : undefined]
            .filter(Boolean)
            .join(" ")}
          type={type ?? "text"}
          inputMode={inputMode}
          value={value}
          readOnly={readOnly}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
          onBlur={onBlur}
        />
      )}
    </Field>
  );
}

export function TextArea({
  value,
  onChange,
  onBlur,
  rows,
  maxLength,
  ...chrome
}: FieldChrome & {
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  rows?: number;
  maxLength?: number;
}) {
  const over = maxLength !== undefined && value.trim().length > maxLength;
  return (
    <Field
      {...chrome}
      meter={
        maxLength === undefined ? undefined : (
          <span className={over ? `${styles.counter} ${styles.counterOver}` : styles.counter}>
            {value.trim().length} / {maxLength}
          </span>
        )
      }
    >
      {(props) => (
        <textarea
          {...props}
          rows={rows}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onBlur={onBlur}
        />
      )}
    </Field>
  );
}

/**
 * A closed enum.
 *
 * `blank` is the label for "not stated" and its absence is what makes a select REQUIRED: a schema
 * enum with no null in it gets no blank option, so the control cannot express a value the document
 * cannot hold.
 */
export function SelectField({
  value,
  onChange,
  options,
  blank,
  labels,
  ...chrome
}: FieldChrome & {
  value: string;
  onChange: (value: string) => void;
  options: readonly string[];
  blank?: string;
  /**
   * What to SHOW for a value, where the schema's token is not English. `up_to` and `vc_fund` are
   * the wire form, not a label; the value the document carries is unaffected.
   */
  labels?: Readonly<Record<string, string>>;
  className?: string;
}) {
  return (
    <Field {...chrome}>
      {(props) => (
        <select {...props} value={value} onChange={(event) => onChange(event.target.value)}>
          {blank === undefined ? null : <option value="">{blank}</option>}
          {options.map((option) => (
            <option key={option} value={option}>
              {labels?.[option] ?? option}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}

/**
 * A `["string", "null"]` enum plus free text: a select of the registered values, with the input
 * still accepting anything.
 *
 * The Standard is explicit that these lists are OPEN — "a publisher's own vocabulary is valid
 * without a schema change" — so a closed `<select>` would be the frontend narrowing the standard.
 * A datalist offers the registry without enforcing it.
 */
export function SuggestField({
  value,
  onChange,
  onBlur,
  options,
  placeholder,
  ...chrome
}: FieldChrome & {
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  options: readonly string[];
  placeholder?: string;
}) {
  const listId = `${fieldId(chrome.path)}-options`;
  return (
    <Field {...chrome}>
      {(props) => (
        <>
          <input
            {...props}
            list={listId}
            value={value}
            placeholder={placeholder}
            onChange={(event) => onChange(event.target.value)}
            onBlur={onBlur}
          />
          <datalist id={listId}>
            {options.map((option) => (
              <option key={option} value={option} />
            ))}
          </datalist>
        </>
      )}
    </Field>
  );
}

/**
 * The Standard's nullable booleans, as the three states they actually have.
 *
 * A checkbox has two, and the missing one is the one most publishers are in: "nobody said". A
 * checkbox here would have every submission asserting `recurring: false` about a programme whose
 * publisher was never asked.
 */
export function TriField({
  value,
  onChange,
  yes,
  no,
  ...chrome
}: FieldChrome & {
  value: "" | "yes" | "no";
  onChange: (value: "" | "yes" | "no") => void;
  yes?: string;
  no?: string;
}) {
  return (
    <Field {...chrome}>
      {(props) => (
        <select
          {...props}
          className={[props.className, styles.tri].filter(Boolean).join(" ")}
          value={value}
          onChange={(event) => onChange(event.target.value as "" | "yes" | "no")}
        >
          <option value="">not stated</option>
          <option value="yes">{yes ?? "yes"}</option>
          <option value="no">{no ?? "no"}</option>
        </select>
      )}
    </Field>
  );
}

/** A plain checkbox, for the places where the two states are the whole truth. */
export function CheckField({
  path,
  label,
  hint,
  checked,
  onChange,
}: {
  path: string;
  label: ReactNode;
  hint?: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const id = fieldId(path);
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <div className="field">
      <label className={styles.check} htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          checked={checked}
          aria-describedby={hintId}
          onChange={(event) => onChange(event.target.checked)}
        />
        {label}
      </label>
      {hint ? (
        <p className="hint" id={hintId}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** A closed enum that takes more than one value: `fundingMechanisms`, `stages`. */
export function CheckList({
  path,
  legend,
  hint,
  options,
  selected,
  onChange,
}: {
  path: string;
  legend: ReactNode;
  hint?: ReactNode;
  options: readonly string[];
  selected: string[];
  onChange: (selected: string[]) => void;
}) {
  return (
    <fieldset className="field">
      <legend>{legend}</legend>
      {hint ? <p className="hint">{hint}</p> : null}
      <div className={styles.checks}>
        {options.map((option) => {
          const id = fieldId(`${path}.${option}`);
          return (
            <label className={styles.check} htmlFor={id} key={option}>
              <input
                id={id}
                type="checkbox"
                checked={selected.includes(option)}
                onChange={(event) => {
                  // Rebuilt from the option list rather than appended to, so the array keeps a
                  // stable order and can never gain a duplicate — both `uniqueItems` arrays.
                  onChange(
                    event.target.checked
                      ? options.filter((each) => each === option || selected.includes(each))
                      : selected.filter((each) => each !== option),
                  );
                }}
              />
              {option}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

/** A numbered section of the form. The number is the stylesheet's counter, not a literal. */
export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className={styles.section}>
      <legend className={styles.legend}>{title}</legend>
      {children}
    </fieldset>
  );
}

/**
 * A repeating group: a list of rows, each removable, with an add button under it.
 *
 * `onMove` is passed ONLY by the two lists whose order means something — the primary operating
 * organisation and the milestone sequence. Arrows on a list whose order is presentational would
 * imply a meaning that is not there.
 */
export function Repeatable<T extends { key: string }>({
  name,
  rows,
  addLabel,
  emptyLabel,
  onAdd,
  onRemove,
  onMove,
  rowLabel,
  children,
}: {
  name: string;
  rows: T[];
  addLabel: string;
  emptyLabel?: string;
  onAdd: () => void;
  onRemove: (index: number) => void;
  onMove?: (index: number, direction: -1 | 1) => void;
  rowLabel: (row: T, index: number) => string;
  children: (row: T, index: number) => ReactNode;
}) {
  return (
    <div className={styles.group}>
      {rows.length === 0 && emptyLabel ? <p className={styles.empty}>{emptyLabel}</p> : null}
      {rows.map((row, index) => (
        <div className={styles.item} key={row.key}>
          <div className={styles.itemHead}>
            <span className={styles.itemName}>{rowLabel(row, index)}</span>
            <div className={styles.itemActions}>
              {onMove ? (
                <>
                  <button
                    type="button"
                    className={styles.small}
                    disabled={index === 0}
                    onClick={() => onMove(index, -1)}
                  >
                    Move up<span className="visually-hidden">: {rowLabel(row, index)}</span>
                  </button>
                  <button
                    type="button"
                    className={styles.small}
                    disabled={index === rows.length - 1}
                    onClick={() => onMove(index, 1)}
                  >
                    Move down<span className="visually-hidden">: {rowLabel(row, index)}</span>
                  </button>
                </>
              ) : null}
              <button type="button" className={styles.small} onClick={() => onRemove(index)}>
                Remove<span className="visually-hidden"> {rowLabel(row, index)}</span>
              </button>
            </div>
          </div>
          {children(row, index)}
        </div>
      ))}
      <button type="button" className={`${styles.small} ${styles.add}`} onClick={onAdd}>
        {addLabel}
        <span className="visually-hidden"> to {name}</span>
      </button>
    </div>
  );
}
