const COPY = {
  listing: "You submitted this listing. The decision will be recorded under your handle.",
  claim: "You filed this claim. The decision will be recorded under your handle.",
} as const;

/** Makes an allowed self-review explicit without changing who is permitted to decide. */
export function SelfReviewNotice({
  kind,
  compact = false,
}: {
  kind: keyof typeof COPY;
  compact?: boolean;
}) {
  const message = <strong>{COPY[kind]}</strong>;
  return compact ? <div className="cell-note">{message}</div> : <p>{message}</p>;
}
