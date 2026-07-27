import { type Check, type Warning, isRecord } from "./types.js";

/**
 * A milestone amount MUST be denominated in the top-level `funding.currency` — a stated rule
 * of the standard, not a soft convention. It is also schema-unenforceable: the two values live
 * in different objects, and JSON Schema cannot express a dependency across them. Warning at
 * ingest is the entire enforcement mechanism the rule has, which is why it lives here.
 */
export const milestoneAmountWithoutCurrency: Check = {
  code: "milestone-amount-without-currency",
  entryPhrase: "carry a milestone amount with no funding.currency to denominate it",
  run(entry) {
    const milestones = entry.milestones;
    if (!Array.isArray(milestones)) return [];

    const funding = entry.funding;
    const currency = isRecord(funding) ? funding.currency : undefined;
    if (typeof currency === "string" && currency.length > 0) return [];

    const out: Warning[] = [];
    milestones.forEach((milestone, i) => {
      if (!isRecord(milestone)) return;
      if (typeof milestone.amount !== "number") return;
      out.push({
        code: this.code,
        instancePath: `/milestones/${i}/amount`,
        message: `milestone amount ${milestone.amount} has no funding.currency to denominate it; milestone amounts must follow the top-level envelope currency`,
      });
    });
    return out;
  },
};
