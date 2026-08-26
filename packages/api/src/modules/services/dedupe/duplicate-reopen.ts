import type { OpportunityDuplicateRow } from "../../../db/schema.js";
import { conflict } from "../../shared/http-error.js";

export type DuplicateReopenTransition = "reopen" | "unchanged";

/** The database-independent policy behind the reviewer reopen route. */
export function duplicateReopenTransition(
  status: OpportunityDuplicateRow["status"],
): DuplicateReopenTransition {
  if (status === "merged") {
    throw conflict(
      "already_merged",
      "that pair has already been merged; a merge is not something a later decision reverses.",
    );
  }
  // Confirmed pairs remain ordinary review decisions: decide() already owns confirmed ↔ dismissed.
  // Reopen exists specifically to undo a dismissal by putting the pair back in the suspected queue.
  if (status === "confirmed") {
    throw conflict(
      "duplicate_not_dismissed",
      "that pair is confirmed, not dismissed; use the existing duplicate decision actions instead.",
    );
  }
  return status === "suspected" ? "unchanged" : "reopen";
}
