import {
  BOUNTY_KINDS,
  FUNDING_TYPES,
  type OpportunityFormState,
  PAYOUT_MODELS,
  emptyDeadline,
  emptyMilestone,
  emptyOrganization,
  emptyPayout,
  emptyPrize,
  emptyRewardTier,
  emptySocialLink,
} from "@/lib/opportunity-form";

const DRAFT_VERSION = 1 as const;
const DRAFT_PREFIX = `rfphub.listing-draft.v${DRAFT_VERSION}.`;
const DRAFT_LIFETIME_MS = 30 * 24 * 60 * 60 * 1_000;

/** Mounted forms flush before logout removes every account's drafts. */
export const BEFORE_DRAFTS_CLEARED_EVENT = "rfphub:before-listing-drafts-cleared";

type Shape = "string" | "boolean" | "number" | { readonly [key: string]: Shape } | readonly [Shape];

const organizationShape = {
  name: "string",
  slug: "string",
  orgType: "string",
  website: "string",
} as const satisfies Shape;
const deadlineShape = {
  deadlineType: "string",
  date: "string",
  label: "string",
} as const satisfies Shape;
const socialShape = { platform: "string", url: "string" } as const satisfies Shape;
const milestoneShape = {
  title: "string",
  amount: "string",
  criteria: "string",
} as const satisfies Shape;
const prizeShape = { track: "string", amount: "string" } as const satisfies Shape;
const payoutShape = {
  model: "string",
  amount: "string",
  min: "string",
  max: "string",
  percent: "string",
  basis: "string",
  floor: "string",
  cap: "string",
} as const satisfies Shape;
const rewardTierShape = {
  severity: "string",
  assetType: "string",
  label: "string",
  payout: payoutShape,
} as const satisfies Shape;

/** The persisted shape is intentionally closed: browser storage is untrusted input on restore. */
const formShape = {
  id: "string",
  idDirty: "boolean",
  fundingType: "string",
  title: "string",
  summary: "string",
  description: "string",
  status: "string",
  ecosystems: "string",
  categories: "string",
  eligibility: "string",
  prerequisites: "string",
  additionalReferences: "string",
  serviceAgreement: "string",
  applicationUrl: "string",
  website: "string",
  logoUrl: "string",
  bannerUrl: "string",
  socialLinks: [socialShape],
  operatingOrganizations: [organizationShape],
  sponsoringOrganizations: [organizationShape],
  currency: "string",
  budget: "string",
  allocated: "string",
  minAward: "string",
  maxAward: "string",
  milestones: [milestoneShape],
  opensAt: "string",
  postedAt: "string",
  deadlines: [deadlineShape],
  details: {
    grant: {
      fundingMechanisms: ["string"],
      programModel: "string",
      milestoneBased: "string",
      recurring: "string",
    },
    hackathon: {
      fullyOnline: "boolean",
      location: "string",
      online: "string",
      tracks: "string",
      prizes: [prizeShape],
      teamMin: "string",
      teamMax: "string",
    },
    bounty: {
      bountyKind: "string",
      rewardMode: "string",
      reward: "string",
      rewardTiers: [rewardTierShape],
      severityScheme: "string",
      rewardPoolStatus: "string",
      difficulty: "string",
      skills: "string",
      platform: "string",
    },
    accelerator: {
      programDurationWeeks: "string",
      batchSize: "string",
      equity: "string",
      funding: "string",
      stage: "string",
      fullyRemote: "boolean",
      location: "string",
      online: "string",
    },
    vc_fund: {
      checkMin: "string",
      checkMax: "string",
      stages: ["string"],
      thesis: "string",
      portfolio: "string",
      contactMethod: "string",
      activelyInvesting: "string",
    },
    rfp: { scope: "string", requirements: "string" },
  },
} as const satisfies Shape;

interface DraftEnvelope {
  version: typeof DRAFT_VERSION;
  accountId: number;
  savedAt: string;
  form: unknown;
}

export type DraftReadResult =
  | { kind: "none" }
  | { kind: "error" }
  | { kind: "draft"; form: OpportunityFormState; savedAt: string };

function storageOrUndefined(storage?: Storage): Storage | undefined {
  if (storage) return storage;
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function opportunityDraftKey(accountId: number): string {
  return `${DRAFT_PREFIX}${accountId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function matchesShape(value: unknown, shape: Shape): boolean {
  if (shape === "string") return typeof value === "string";
  if (shape === "boolean") return typeof value === "boolean";
  if (shape === "number") return typeof value === "number";
  if (Array.isArray(shape)) {
    return Array.isArray(value) && value.every((item) => matchesShape(item, shape[0]));
  }
  if (!isRecord(value)) return false;
  const entries = Object.entries(shape);
  return (
    Object.keys(value).length === entries.length &&
    entries.every(([key, child]) => key in value && matchesShape(value[key], child))
  );
}

/** Remove browser-only row identities and every create-time carry-through base. */
function formForStorage(form: OpportunityFormState): unknown {
  const prune = (value: unknown, key?: string): unknown => {
    if (key === "key" || key === "base" || key === "teamBase" || key === "checkBase") {
      return undefined;
    }
    if (Array.isArray(value)) {
      return value.map((item) => prune(item));
    }
    if (!isRecord(value)) return value;
    return Object.fromEntries(
      Object.entries(value).flatMap(([childKey, child]) => {
        const pruned = prune(child, childKey);
        return pruned === undefined ? [] : [[childKey, pruned]];
      }),
    );
  };
  return prune(form);
}

/** Stable comparison for dirty state; only generated row keys are ignored. */
export function canonicalForm(form: OpportunityFormState): string {
  const withoutKeys = (value: unknown, key?: string): unknown => {
    if (key === "key") return undefined;
    if (Array.isArray(value)) return value.map((item) => withoutKeys(item));
    if (!isRecord(value)) return value;
    return Object.fromEntries(
      Object.entries(value).flatMap(([childKey, child]) => {
        const canonical = withoutKeys(child, childKey);
        return canonical === undefined ? [] : [[childKey, canonical]];
      }),
    );
  };
  return JSON.stringify(withoutKeys(form));
}

function restoreForm(value: unknown): OpportunityFormState | null {
  if (!matchesShape(value, formShape)) return null;
  const stored = value as Omit<OpportunityFormState, "details"> & {
    details: Omit<OpportunityFormState["details"], "hackathon" | "vc_fund"> & {
      hackathon: Omit<OpportunityFormState["details"]["hackathon"], "teamBase">;
      vc_fund: Omit<OpportunityFormState["details"]["vc_fund"], "checkBase">;
    };
  };
  if (!FUNDING_TYPES.includes(stored.fundingType)) return null;
  if (
    stored.deadlines.some((row) => row.deadlineType !== "fixed" && row.deadlineType !== "rolling")
  ) {
    return null;
  }
  if (!BOUNTY_KINDS.includes(stored.details.bounty.bountyKind)) return null;
  if (!["single", "tiers"].includes(stored.details.bounty.rewardMode)) return null;
  if (stored.details.bounty.rewardTiers.some((row) => !PAYOUT_MODELS.includes(row.payout.model))) {
    return null;
  }

  return {
    ...stored,
    socialLinks: stored.socialLinks.map((row) => ({ ...emptySocialLink(), ...row })),
    operatingOrganizations: stored.operatingOrganizations.map((row) => ({
      ...emptyOrganization(),
      ...row,
    })),
    sponsoringOrganizations: stored.sponsoringOrganizations.map((row) => ({
      ...emptyOrganization(),
      ...row,
    })),
    milestones: stored.milestones.map((row) => ({ ...emptyMilestone(), ...row })),
    deadlines: stored.deadlines.map((row) => ({ ...emptyDeadline(), ...row })),
    details: {
      ...stored.details,
      hackathon: {
        ...stored.details.hackathon,
        teamBase: {},
        prizes: stored.details.hackathon.prizes.map((row) => ({ ...emptyPrize(), ...row })),
      },
      bounty: {
        ...stored.details.bounty,
        rewardTiers: stored.details.bounty.rewardTiers.map((row) => ({
          ...emptyRewardTier(),
          ...row,
          payout: { ...emptyPayout(), ...row.payout },
        })),
      },
      vc_fund: { ...stored.details.vc_fund, checkBase: {} },
    },
  } as OpportunityFormState;
}

export function readOpportunityDraft(
  accountId: number,
  options: { storage?: Storage; now?: number } = {},
): DraftReadResult {
  const storage = storageOrUndefined(options.storage);
  if (!storage) return { kind: "error" };
  try {
    const raw = storage.getItem(opportunityDraftKey(accountId));
    if (!raw) return { kind: "none" };
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return { kind: "none" };
    const envelope = parsed as Partial<DraftEnvelope>;
    const savedAt =
      typeof envelope.savedAt === "string" ? Date.parse(envelope.savedAt) : Number.NaN;
    if (
      envelope.version !== DRAFT_VERSION ||
      envelope.accountId !== accountId ||
      !Number.isFinite(savedAt)
    ) {
      return { kind: "none" };
    }
    if ((options.now ?? Date.now()) - savedAt > DRAFT_LIFETIME_MS) {
      storage.removeItem(opportunityDraftKey(accountId));
      return { kind: "none" };
    }
    const form = restoreForm(envelope.form);
    return form ? { kind: "draft", form, savedAt: envelope.savedAt as string } : { kind: "none" };
  } catch {
    return { kind: "error" };
  }
}

export function writeOpportunityDraft(
  accountId: number,
  form: OpportunityFormState,
  options: { storage?: Storage; now?: Date } = {},
): { ok: true; savedAt: string } | { ok: false } {
  const storage = storageOrUndefined(options.storage);
  if (!storage) return { ok: false };
  const savedAt = (options.now ?? new Date()).toISOString();
  try {
    storage.setItem(
      opportunityDraftKey(accountId),
      JSON.stringify({ version: DRAFT_VERSION, accountId, savedAt, form: formForStorage(form) }),
    );
    return { ok: true, savedAt };
  } catch {
    return { ok: false };
  }
}

export function removeOpportunityDraft(accountId: number, storage?: Storage): boolean {
  const available = storageOrUndefined(storage);
  if (!available) return false;
  try {
    available.removeItem(opportunityDraftKey(accountId));
    return true;
  } catch {
    return false;
  }
}

/** Logout clears all accounts, not only the active one, for shared-machine privacy. */
export function clearAllOpportunityDrafts(storage?: Storage): boolean {
  const available = storageOrUndefined(storage);
  if (!available) return false;
  try {
    if (typeof window !== "undefined") {
      window.dispatchEvent(new Event(BEFORE_DRAFTS_CLEARED_EVENT));
    }
    for (let index = available.length - 1; index >= 0; index -= 1) {
      const key = available.key(index);
      if (key?.startsWith(DRAFT_PREFIX)) available.removeItem(key);
    }
    return true;
  } catch {
    return false;
  }
}
