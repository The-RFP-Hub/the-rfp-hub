import { amountWithoutCurrency } from "./currency.js";
import { payoutBoundsInverted } from "./payout.js";
import {
  unregisteredDeadlineLabel,
  unregisteredProgramModel,
  unregisteredTierAssetType,
  unregisteredTierSeverity,
} from "./registry.js";
import { type Check, type Warning, isRecord } from "./types.js";

/**
 * The advisory checks, in report order. Each one covers something the schema deliberately
 * leaves open — see ./types.ts for why the two tiers are separate.
 */
export const checks: readonly Check[] = [
  unregisteredDeadlineLabel,
  unregisteredProgramModel,
  unregisteredTierSeverity,
  unregisteredTierAssetType,
  amountWithoutCurrency,
  payoutBoundsInverted,
];

/** Run every advisory check against one entry. Never throws; non-objects yield no warnings. */
export function runChecks(data: unknown): Warning[] {
  if (!isRecord(data)) return [];
  return checks.flatMap((check) => check.run(data));
}

/** The count-phrase for a code, for "N of M entries <phrase>" output. */
export function entryPhrase(code: string): string {
  return checks.find((c) => c.code === code)?.entryPhrase ?? `raise ${code}`;
}

export type { Check, Warning };
export {
  amountWithoutCurrency,
  payoutBoundsInverted,
  unregisteredDeadlineLabel,
  unregisteredProgramModel,
  unregisteredTierAssetType,
  unregisteredTierSeverity,
};
