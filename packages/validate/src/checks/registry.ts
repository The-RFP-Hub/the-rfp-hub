import { activeValues, isRegistered } from "@the-rfp-hub/standard";
import { type Check, type Warning, isRecord } from "./types.js";

const shortList = (name: Parameters<typeof activeValues>[0]) => activeValues(name).join(", ");

/**
 * Since every per-type date folds into `deadlines[]`, the label is the ONLY thing separating
 * "when must I apply by?" from "when does the event start?". An unregistered label is a
 * deadline a consumer cannot route on.
 */
export const unregisteredDeadlineLabel: Check = {
  code: "unregistered-deadline-label",
  entryPhrase: "use an unregistered deadline label",
  run(entry) {
    const deadlines = entry.deadlines;
    if (!Array.isArray(deadlines)) return [];
    const out: Warning[] = [];
    deadlines.forEach((deadline, i) => {
      if (!isRecord(deadline)) return;
      const label = deadline.label;
      if (typeof label !== "string" || label.length === 0) return;
      if (isRegistered("deadline-labels", label)) return;
      out.push({
        code: this.code,
        instancePath: `/deadlines/${i}/label`,
        message: `deadline label '${label}' is not registered; conventional labels are ${shortList("deadline-labels")}`,
      });
    });
    return out;
  },
};

/**
 * `fundingDetails.programModel` (a grant field) is an open string because it came from one
 * publisher's taxonomy and a closed enum would have imposed that taxonomy on everyone else.
 * The registry keeps the common cases comparable without closing the field.
 */
export const unregisteredProgramModel: Check = {
  code: "unregistered-program-model",
  entryPhrase: "use an unregistered programModel",
  run(entry) {
    const details = entry.fundingDetails;
    if (!isRecord(details)) return [];
    const model = details.programModel;
    if (typeof model !== "string" || model.length === 0) return [];
    if (isRegistered("program-models", model)) return [];
    return [
      {
        code: this.code,
        instancePath: "/fundingDetails/programModel",
        message: `programModel '${model}' is not registered; conventional values are ${shortList("program-models")}`,
      },
    ];
  },
};

/**
 * A reward tier's `severity` and `assetType` are open strings for the same reason
 * `programModel` is: the observed vocabularies come from one platform, and a closed enum would
 * write that platform's taxonomy into the standard. The registries keep the common values
 * comparable — which is the whole point of grading a payout, since "which programs pay more
 * than $X for a critical" is unanswerable if two publishers spell 'critical' differently.
 */
const tierVocabulary = (
  code: string,
  entryPhrase: string,
  field: "severity" | "assetType",
  registry: "bounty-severities" | "bounty-asset-types",
): Check => ({
  code,
  entryPhrase,
  run(entry) {
    const details = entry.fundingDetails;
    if (!isRecord(details) || !Array.isArray(details.rewardTiers)) return [];
    const out: Warning[] = [];
    details.rewardTiers.forEach((tier, i) => {
      if (!isRecord(tier)) return;
      const value = tier[field];
      if (typeof value !== "string" || value.length === 0) return;
      if (isRegistered(registry, value)) return;
      out.push({
        code,
        instancePath: `/fundingDetails/rewardTiers/${i}/${field}`,
        message: `reward tier ${field} '${value}' is not registered; conventional values are ${shortList(registry)}`,
      });
    });
    return out;
  },
});

export const unregisteredTierSeverity = tierVocabulary(
  "unregistered-tier-severity",
  "use an unregistered reward-tier severity",
  "severity",
  "bounty-severities",
);

export const unregisteredTierAssetType = tierVocabulary(
  "unregistered-tier-asset-type",
  "use an unregistered reward-tier assetType",
  "assetType",
  "bounty-asset-types",
);
