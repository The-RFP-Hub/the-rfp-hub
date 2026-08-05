import { type Check, type Warning, isRecord } from "./types.js";

/**
 * Every monetary amount in a document MUST be denominated in the top-level
 * `fundingInfo.currency` — a stated rule of the standard, not a soft convention. It is also
 * schema-unenforceable: the amounts and the currency live in different objects, and JSON
 * Schema cannot express a dependency across them. Warning at ingest is the entire enforcement
 * mechanism the rule has, which is why it lives here.
 *
 * One warning fires per offending site: the envelope's own amounts (budget, allocated,
 * minAward, maxAward), milestones[].amount, and the per-type fundingDetails amounts —
 * bounty reward, accelerator funding, hackathon prize amounts, and vc_fund checkSize bounds.
 */
export const amountWithoutCurrency: Check = {
  code: "amount-without-currency",
  entryPhrase: "carry a monetary amount with no fundingInfo.currency to denominate it",
  run(entry) {
    const funding = isRecord(entry.fundingInfo) ? entry.fundingInfo : undefined;
    const currency = funding?.currency;
    if (typeof currency === "string" && currency.length > 0) return [];

    const out: Warning[] = [];
    const flag = (label: string, instancePath: string, value: unknown) => {
      if (typeof value !== "number") return;
      out.push({
        code: this.code,
        instancePath,
        message: `${label} ${value} has no fundingInfo.currency to denominate it; every monetary amount in the document must be denominated in the envelope currency`,
      });
    };

    if (funding) {
      for (const field of ["budget", "allocated", "minAward", "maxAward"] as const) {
        flag(`fundingInfo.${field}`, `/fundingInfo/${field}`, funding[field]);
      }
    }

    const details = isRecord(entry.fundingDetails) ? entry.fundingDetails : undefined;
    if (details) {
      flag("bounty reward", "/fundingDetails/reward", details.reward);
      flag("accelerator funding", "/fundingDetails/funding", details.funding);
      if (Array.isArray(details.prizes)) {
        details.prizes.forEach((prize, i) => {
          if (!isRecord(prize)) return;
          flag("prize amount", `/fundingDetails/prizes/${i}/amount`, prize.amount);
        });
      }
      if (isRecord(details.checkSize)) {
        flag("checkSize.min", "/fundingDetails/checkSize/min", details.checkSize.min);
        flag("checkSize.max", "/fundingDetails/checkSize/max", details.checkSize.max);
      }
    }

    if (Array.isArray(entry.milestones)) {
      entry.milestones.forEach((milestone, i) => {
        if (!isRecord(milestone)) return;
        flag("milestone amount", `/milestones/${i}/amount`, milestone.amount);
      });
    }

    return out;
  },
};
