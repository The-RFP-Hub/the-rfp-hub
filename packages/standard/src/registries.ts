import deadlineLabels from "../registries/deadline-labels.json";
import eligibilityKeys from "../registries/eligibility-keys.json";
import programModels from "../registries/program-models.json";

/** One registered value in an open vocabulary. */
export interface RegistryEntry {
  description: string;
  status: "active" | "deprecated";
  since: string;
  replacedBy?: string | null;
  reference?: string | null;
  examples?: string[];
}

/** A whole registry: a flat map from the registered value to its entry. */
export type Registry = Readonly<Record<string, RegistryEntry>>;

/**
 * The open vocabularies the standard governs by registry rather than by enum.
 *
 * The schema keeps these fields free-text on purpose — a closed enum built from one
 * publisher's vocabulary would force every other publisher into it. The registry is what
 * keeps the values interoperable anyway: tooling warns on unregistered values without
 * rejecting them, so a publisher is never blocked and drift is still visible.
 *
 * `ecosystems` and `networks` are open too but deliberately have **no** registry. A registry
 * over a list of chain names reads as an allowed-values list no matter what the normative
 * document says, and it would put a process in front of a newly launched chain for no gain.
 */
export const registries = {
  "deadline-labels": deadlineLabels as Registry,
  "eligibility-keys": eligibilityKeys as Registry,
  "program-models": programModels as Registry,
} as const satisfies Record<string, Registry>;

/** Name of one of the bundled registries. */
export type RegistryName = keyof typeof registries;

/** Whether `value` is registered in `name` (any status). */
export function isRegistered(name: RegistryName, value: string): boolean {
  return Object.hasOwn(registries[name], value);
}

/** The values registered in `name` with `status: "active"`, sorted. */
export function activeValues(name: RegistryName): string[] {
  return Object.entries(registries[name])
    .filter(([, e]) => e.status === "active")
    .map(([k]) => k)
    .sort();
}
