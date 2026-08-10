import { type Check, type Warning, isRecord } from "./types.js";

/**
 * A payout's bounds must not cross: `min` above `max`, or `floor` above `cap`, describes a
 * tier nobody can be paid under. JSON Schema cannot compare two sibling values, so this is the
 * only place the rule can be enforced — the same reason the currency rule lives here.
 */
export const payoutBoundsInverted: Check = {
  code: "payout-bounds-inverted",
  entryPhrase: "carry a reward tier whose payout bounds cross",
  run(entry) {
    const details = entry.fundingDetails;
    if (!isRecord(details) || !Array.isArray(details.rewardTiers)) return [];
    const out: Warning[] = [];
    details.rewardTiers.forEach((tier, i) => {
      if (!isRecord(tier) || !isRecord(tier.payout)) return;
      const payout = tier.payout;
      const pairs = [
        ["min", "max"],
        ["floor", "cap"],
      ] as const;
      for (const [lo, hi] of pairs) {
        const low = payout[lo];
        const high = payout[hi];
        if (typeof low !== "number" || typeof high !== "number") continue;
        if (low <= high) continue;
        out.push({
          code: this.code,
          instancePath: `/fundingDetails/rewardTiers/${i}/payout/${lo}`,
          message: `reward tier payout ${lo} ${low} is above ${hi} ${high}; no amount satisfies the bound`,
        });
      }
    });
    return out;
  },
};
