/**
 * Recorded upstream-shaped inputs: trimmed real programs from an upstream funding-map
 * /v2/program-registry/search API. These are the SOURCE side of the contract — what the upstream
 * actually sends — kept separate from the assertions so they can be reused by any test that needs
 * to prove the mapper's output conforms.
 *
 * The upstream still speaks the PRE-RE-CUT vocabulary (single `organization`, one `deadline`,
 * per-block date fields, scalar `fundingMechanism`, `totalBudget`); `map-program.ts` is where the
 * conversion to the re-cut Standard happens. Every shape here therefore doubles as a regression
 * test for that conversion.
 *
 * Adding a fixture to `UPSTREAM_PROGRAMS` below automatically enrolls it in the
 * "mapper output validates against the real schema" suite — nothing else to wire up.
 */
import type { RegistryProgram } from "../map-program.js";

// The upstream still speaks the PRE-RE-CUT vocabulary (single org, one `deadline`, per-block date
// fields, `fundingMechanism`) — mapProgram is where the conversion to the re-cut shape happens.
export const grantProgram: RegistryProgram = {
  id: "6a049b3188f4252180420a47",
  programId: "1479",
  type: "grant",
  isActive: true,
  deadline: null,
  submissionUrl: null,
  communities: [{ uid: "0x34…", name: "Filecoin", slug: "filecoin" }],
  createdAt: "2026-05-13T15:39:29.000Z",
  updatedAt: "2026-06-18T22:42:23.000Z",
  metadata: {
    title: "Filecoin ProPGF Batch 3",
    description: "A $2M milestone-based funding program.",
    shortDescription: "Filecoin ProPGF Batch 3",
    status: "Active",
    startsAt: "2026-05-26T00:00:00.000Z",
    endsAt: "2026-06-16T23:59:00.000Z",
    programBudget: "2000000",
    ecosystems: [],
    socialLinks: { twitter: "", discord: "", website: "" },
  },
};

export const hackathonProgram: RegistryProgram = {
  programId: "1486",
  type: "hackathon",
  isActive: true,
  deadline: "2026-06-20T18:29:00.000Z",
  submissionUrl: "https://example.devfolio.co",
  communities: [{ name: "Ethereum", slug: "ethereum" }],
  metadata: {
    title: "Some Hackathon",
    description: "Build cool things.",
    programBudget: "2026 USD",
    ecosystems: ["Ethereum"],
  },
  hackathonMetadata: {
    startDate: "2026-06-01T18:29:00.000Z",
    endDate: "2026-06-30T18:29:00.000Z",
    registrationDeadline: "2026-05-20T18:29:00.000Z",
    submissionDeadline: "2026-06-29T18:29:00.000Z",
    location: "Online",
    // upstream sometimes sends amount as a string and float team bounds — must be coerced;
    // the per-prize currency has no re-cut slot and hoists into fundingInfo.currency
    prizes: [{ amount: "2026", currency: "USD" }],
    teamSize: { min: "1", max: 5.0 },
  },
};

// Messy: non-URL submissionUrl (dropped) + non-numeric prize amount; relies on the provenance base.
export const messyProgram: RegistryProgram = {
  programId: "9999",
  type: "bounty",
  isActive: false,
  submissionUrl: "not a url",
  communities: [],
  metadata: { title: "Messy Bounty", description: "", programBudget: "110 USDC" },
  bountyMetadata: {
    // pre-re-cut money object → plain number reward; the currency hoists to fundingInfo.currency
    reward: { amount: "110", currency: "USDC" },
    skills: ["Content"],
    difficulty: "expert", // not in the Standard enum → must be dropped
  },
};

// vc_fund with dup ecosystems, an uppercase/underscore community slug, and a bad enum in `stages`.
export const vcProgram: RegistryProgram = {
  programId: "555",
  type: "vc_fund",
  isActive: true,
  communities: [{ name: "Ethereum", slug: "OP_Mainnet" }],
  metadata: { title: "Fund X", description: "We invest.", ecosystems: ["Ethereum", "Ethereum"] },
  vcFundMetadata: {
    stages: ["seed", "bogus"],
    contactMethod: "form",
    activelyInvesting: true,
    thesis: "DeFi",
  },
};

export const rfpProgram: RegistryProgram = {
  programId: "1242",
  type: "rfp",
  isActive: false,
  communities: [{ name: "zkSync", slug: "zksync" }],
  metadata: { title: "RFP 3 Institutional Narrative", description: "10-week activation." },
  rfpMetadata: {
    issuingOrganization: "ZKsync Foundation",
    budget: { amount: 15000, currency: "USD" },
    proposalDeadline: "2026-03-20T00:00:00.000Z",
    scope: "Content strategy with KPIs.",
    requirements: ["Weekly reporting"],
  },
};

export const acceleratorProgram: RegistryProgram = {
  programId: "1291",
  type: "accelerator",
  isActive: true,
  communities: [{ name: "Base", slug: "base" }],
  metadata: { title: "Base Batch", description: "An accelerator." },
  acceleratorMetadata: {
    applicationDeadline: "2026-08-01T00:00:00.000Z",
    programDurationWeeks: 12,
    batchSize: 20,
    stage: "seed",
  },
};

// Pre-re-cut grant block: the SCALAR `fundingMechanism`, plus the new open `programModel` string.
export const mechanismProgram: RegistryProgram = {
  programId: "777",
  type: "grant",
  isActive: true,
  communities: [{ name: "Optimism", slug: "optimism" }],
  metadata: { title: "Retro Round", description: "Retro funding." },
  grantMetadata: {
    fundingMechanism: "retroactive",
    programModel: "incentives",
    recurring: true,
    milestoneBased: false,
  },
};

/**
 * The upstream names the REAL organisations behind a program in `metadata.organizations`, and this
 * shape is the one that used to be mapped worst: the program title was published as the
 * organisation's name and the community slug as its identity. It also carries the fields that had
 * no mapping at all — committed-to-date, the open/closed applicant flag, an org website, and a
 * program page distinct from the submission URL — plus `grantsToDate` and a non-UTC timestamp,
 * which the closed core and the UTC rule respectively have something to say about.
 */
export const multiOrgProgram: RegistryProgram = {
  programId: "2050",
  type: "grant",
  isActive: true,
  submissionUrl: "https://apply.example.org/frontier",
  communities: [{ name: "Solana", slug: "solana" }],
  // a LOCAL-OFFSET timestamp: the same instant as 10:00Z, which the mapper must convert rather
  // than relabel (the re-cut requires a trailing 'Z' on every timestamp)
  createdAt: "2026-01-05T07:00:00.000-03:00",
  updatedAt: "2026-02-05T10:00:00.000Z",
  metadata: {
    title: "Frontier Builders Round",
    description: "Grants for frontier builders.",
    // two real organisations, plus a case-variant repeat of the first — the upstream is not deduped
    organizations: ["Solana Foundation", "Colosseum", "solana foundation"],
    anyoneCanJoin: true,
    amountDistributedToDate: "125000",
    // award COUNT to date — the closed core has no field for it, so it is a recorded loss
    grantsToDate: 12,
    socialLinks: {
      orgWebsite: "https://foundation.example.org",
      grantsSite: "https://example.org/frontier-round",
    },
  },
};

/** Same shape with nothing but the title to go on — the fallback path, and an invite-only program. */
export const unnamedOrgProgram: RegistryProgram = {
  programId: "2051",
  type: "grant",
  isActive: true,
  communities: [{ name: "Base", slug: "base" }],
  metadata: {
    title: "Anonymous Builders Round",
    description: "A program whose organisations the upstream never names.",
    organizations: ["", "   "], // present but empty — still "genuinely absent"
    anyoneCanJoin: false,
    amountDistributedToDate: "0", // upstream's default: no information, not a fact
  },
};

/** Every recorded upstream shape, by the funding type it exercises. */
export const UPSTREAM_PROGRAMS: Record<string, RegistryProgram> = {
  grant: grantProgram,
  hackathon: hackathonProgram,
  "bounty (messy)": messyProgram,
  vc_fund: vcProgram,
  rfp: rfpProgram,
  accelerator: acceleratorProgram,
  "grant (legacy scalar mechanism)": mechanismProgram,
  "grant (named organisations)": multiOrgProgram,
  "grant (unnamed organisation)": unnamedOrgProgram,
};
