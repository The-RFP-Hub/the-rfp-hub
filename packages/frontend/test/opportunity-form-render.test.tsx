import { NavigationBlockerProvider } from "@/components/NavigationBlocker";
/**
 * THE FORM AS A PUBLISHER MEETS IT.
 *
 * The pure mapping is proven in `opportunity-form.test.ts`. What cannot be proven there is the part
 * that only exists once the thing is on screen: whether flipping a control actually CHANGES THE
 * DOCUMENT rather than merely hiding an input, when a problem is allowed to appear, and whether a
 * successful submission can be sent twice.
 *
 * Four of these are conditional rules from the Standard, and every one of them has the same failure
 * mode if it is implemented as "stop rendering the old field": the value stays in state, gets
 * submitted, and fails validation on a field the publisher can no longer see. So each is asserted
 * against the payload the API client was handed, not against the DOM.
 *
 * The API client is injected through the same context the application uses. No network, no auth SDK.
 */
import { OpportunityForm } from "@/components/OpportunityForm";
import styles from "@/components/OpportunityForm.module.css";
import type { ApiClient } from "@/lib/api";
import { ApiClientProvider } from "@/lib/api-context";
import {
  opportunityDraftKey,
  readOpportunityDraft,
  writeOpportunityDraft,
} from "@/lib/opportunity-draft";
import {
  type OpportunityFormState,
  emptyForm,
  emptyOrganization,
  fromDocument,
} from "@/lib/opportunity-form";
import type { Opportunity, SubmissionResult } from "@/lib/types";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { AnchorHTMLAttributes } from "react";
import { describe, expect, it, vi } from "vitest";

// Next's real Link only emits `onNavigate` inside an App Router. This focused component suite does
// not mount a router, so the test double translates an anchor click into that documented event.
vi.mock("next/link", () => ({
  default: ({
    onNavigate,
    ...props
  }: AnchorHTMLAttributes<HTMLAnchorElement> & {
    onNavigate?: (event: { preventDefault: () => void }) => void;
  }) => (
    <a
      {...props}
      href={props.href ?? "/"}
      onClick={(event) => {
        onNavigate?.({ preventDefault: () => event.preventDefault() });
        event.preventDefault();
      }}
    />
  ),
}));

const BASE_URL = "https://api.example.com";

function outcome(over: Partial<SubmissionResult> = {}): SubmissionResult {
  return {
    opportunity: { id: "acme:round-one", title: "Round One" } as unknown as Opportunity,
    created: true,
    reviewStatus: "approved",
    isListed: true,
    warnings: [],
    duplicateCheck: "ran",
    duplicates: [],
    ...over,
  } as SubmissionResult;
}

function stub(result: SubmissionResult = outcome()) {
  const create = vi.fn(async () => result);
  const replace = vi.fn(async () => result);
  return {
    create,
    replace,
    client: {
      baseUrl: BASE_URL,
      opportunities: { create, replace },
    } as unknown as ApiClient,
  };
}

/** The form, filled in far enough to be conformant, so a test can break exactly one thing. */
function mount(
  over: Parameters<typeof fill>[0] = {},
  options: { mode?: "create" | "edit"; initial?: OpportunityFormState; accountId?: number } = {},
) {
  const api = stub();
  const initial = options.initial ?? fill(over);
  const view = render(
    <ApiClientProvider value={api.client}>
      <NavigationBlockerProvider>
        <OpportunityForm
          mode={options.mode ?? "create"}
          accountId={options.accountId}
          initial={initial}
          authority={{ verifiedNamespaces: ["acme"], directCreate: false }}
        />
      </NavigationBlockerProvider>
    </ApiClientProvider>,
  );
  return Object.assign(api, { unmount: view.unmount });
}

function fill(over: Partial<OpportunityFormState> = {}): OpportunityFormState {
  const form = emptyForm();
  return {
    ...form,
    id: "acme:round-one",
    idDirty: true,
    title: "Round One",
    description: "A description.",
    operatingOrganizations: [{ ...emptyOrganization(), name: "Acme Foundation", slug: "acme" }],
    ...over,
  };
}

const submit = () => fireEvent.click(screen.getByRole("button", { name: "Submit" }));

/** `getAllBy*` is typed as possibly-sparse; every use here has already asserted the length. */
const nth = <T,>(items: T[], index: number): T => items[index] as T;

/** The suite carries no jest-dom, so the DOM assertions are made against the DOM. */
const valueIn = (element: HTMLElement) => (element as HTMLInputElement).value;

/** The document the API client was actually handed. */
const sent = (api: ReturnType<typeof stub>) =>
  (api.create.mock.calls[0] as unknown[])[0] as Record<string, unknown>;

const detailsOf = (api: ReturnType<typeof stub>) =>
  sent(api).fundingDetails as Record<string, unknown>;

describe("switching funding type", () => {
  it("does not carry the previous branch's fields into the new one", async () => {
    const form = fill({ fundingType: "hackathon" });
    form.details.hackathon.tracks = "DeFi, Infra";
    form.details.hackathon.location = "Berlin";
    const api = mount({}, { initial: form });

    // The hackathon inputs are on screen…
    expect(valueIn(screen.getByLabelText("Tracks — optional"))).toBe("DeFi, Infra");

    fireEvent.change(screen.getByLabelText("Funding type"), { target: { value: "grant" } });

    // …and gone, along with everything they held.
    expect(screen.queryByLabelText("Tracks — optional")).toBeNull();
    submit();

    await waitFor(() => expect(api.create).toHaveBeenCalled());
    expect(detailsOf(api)).toEqual({ fundingType: "grant" });
  });

  it("names the funding-details section after the schema field and the type", () => {
    mount();
    expect(screen.getByText("Funding details — Grant")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Funding type"), { target: { value: "rfp" } });
    expect(screen.getByText("Funding details — Request for proposals")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Funding type"), { target: { value: "vc_fund" } });
    expect(screen.getByText("Funding details — Venture fund")).toBeTruthy();
  });

  it("names the sections that map to a schema field after that field", () => {
    mount();
    // `fundingInfo` and `deadlines` are what a conformance error will call them, so they are what
    // the form calls them too.
    expect(screen.getByText("Funding information")).toBeTruthy();
    expect(screen.getByText("Deadlines and dates")).toBeTruthy();
    expect(screen.queryByText("Money")).toBeNull();
    expect(screen.queryByText("Dates")).toBeNull();
  });
});

describe("the bounty's exactly-one compensation rule", () => {
  it("a task bounty offers a single reward, and the table replaces it outright", async () => {
    const form = fill({ fundingType: "bounty" });
    form.details.bounty = { ...form.details.bounty, bountyKind: "task", reward: "500" };
    const api = mount({}, { initial: form });

    expect(valueIn(screen.getByLabelText("Reward"))).toBe("500");

    fireEvent.change(screen.getByLabelText("Compensation"), { target: { value: "tiers" } });
    expect(screen.queryByLabelText("Reward")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "+ Add a tier" }));
    fireEvent.change(screen.getByLabelText(/^Severity, tier 1/), { target: { value: "high" } });
    fireEvent.change(screen.getByLabelText(/^Amount, tier 1/), { target: { value: "500" } });
    submit();

    await waitFor(() => expect(api.create).toHaveBeenCalled());
    const details = detailsOf(api);
    // Not hidden — absent. A document carrying both has two sources of truth for the same money.
    expect("reward" in details).toBe(false);
    expect(details.rewardTiers).toEqual([
      { severity: "high", payout: { model: "fixed", amount: 500 } },
    ]);
  });

  it("a security bounty is given the table and never the single reward", () => {
    const form = fill({ fundingType: "bounty" });
    form.details.bounty = { ...form.details.bounty, bountyKind: "task", reward: "500" };
    mount({}, { initial: form });

    fireEvent.change(screen.getByLabelText("Bounty kind"), { target: { value: "security" } });

    expect(screen.queryByLabelText("Reward")).toBeNull();
    expect(screen.queryByLabelText("Compensation")).toBeNull();
    expect(screen.getByRole("button", { name: "+ Add a tier" })).toBeTruthy();
  });

  it("refuses to send a security bounty with an empty table, and says why", () => {
    const form = fill({ fundingType: "bounty" });
    form.details.bounty = { ...form.details.bounty, bountyKind: "security" };
    const api = mount({}, { initial: form });

    submit();

    expect(api.create).not.toHaveBeenCalled();
    expect(screen.getAllByText(/pays against a reward table/).length).toBeGreaterThan(0);
  });
});

describe("switching a tier's payout model", () => {
  const tierForm = () => {
    const form = fill({ fundingType: "bounty" });
    form.details.bounty = {
      ...form.details.bounty,
      bountyKind: "security",
      rewardTiers: [
        {
          key: "t1",
          severity: "critical",
          assetType: "",
          label: "",
          base: {},
          payout: {
            model: "fixed",
            amount: "1000",
            min: "",
            max: "",
            percent: "",
            basis: "value_at_risk",
            floor: "",
            cap: "",
            base: {},
          },
        },
      ],
    };
    return form;
  };

  it("clears the amounts the new model forbids", async () => {
    const api = mount({}, { initial: tierForm() });

    expect(valueIn(screen.getByLabelText(/^Amount, tier 1/))).toBe("1000");
    fireEvent.change(screen.getByLabelText(/^Payout model, tier 1/), {
      target: { value: "range" },
    });

    // The amount box is gone, and so is its value — retyped bounds are all that survives.
    expect(screen.queryByLabelText(/^Amount, tier 1/)).toBeNull();
    fireEvent.change(screen.getByLabelText(/^Lower bound, tier 1/), { target: { value: "10" } });
    fireEvent.change(screen.getByLabelText(/^Upper bound, tier 1/), { target: { value: "20" } });
    submit();

    await waitFor(() => expect(api.create).toHaveBeenCalled());
    const tiers = detailsOf(api).rewardTiers as Record<string, unknown>[];
    expect(tiers[0]?.payout).toEqual({ model: "range", min: 10, max: 20 });
  });

  it("names no figure at all on a discretionary tier", async () => {
    const api = mount({}, { initial: tierForm() });

    fireEvent.change(screen.getByLabelText(/^Payout model, tier 1/), {
      target: { value: "discretionary" },
    });
    expect(screen.getByText("Decided case by case — no figure.")).toBeTruthy();
    submit();

    await waitFor(() => expect(api.create).toHaveBeenCalled());
    const tiers = detailsOf(api).rewardTiers as Record<string, unknown>[];
    expect(tiers[0]?.payout).toEqual({ model: "discretionary" });
  });

  it("asks for a basis on a percentage, because the tag never implies one", async () => {
    const api = mount({}, { initial: tierForm() });

    fireEvent.change(screen.getByLabelText(/^Payout model, tier 1/), {
      target: { value: "percentage" },
    });
    fireEvent.change(screen.getByLabelText(/^Percentage, tier 1/), { target: { value: "10" } });
    fireEvent.change(screen.getByLabelText(/^Basis, tier 1/), {
      target: { value: "economic_damage" },
    });
    submit();

    await waitFor(() => expect(api.create).toHaveBeenCalled());
    const tiers = detailsOf(api).rewardTiers as Record<string, unknown>[];
    expect(tiers[0]?.payout).toEqual({
      model: "percentage",
      percent: 10,
      basis: "economic_damage",
    });
  });
});

describe("a deadline", () => {
  it("asks for a date when it is fixed and drops it when it turns rolling", async () => {
    const api = mount();

    fireEvent.click(screen.getByRole("button", { name: /\+ Add a deadline/ }));
    fireEvent.change(screen.getByLabelText(/^Date/), { target: { value: "2026-09-30T23:59" } });

    fireEvent.change(screen.getByLabelText("Deadline kind"), { target: { value: "rolling" } });
    expect(screen.queryByLabelText(/^Date/)).toBeNull();
    expect(screen.getByText(/accepted continuously/)).toBeTruthy();

    submit();
    await waitFor(() => expect(api.create).toHaveBeenCalled());
    expect(sent(api).deadlines).toEqual([{ deadlineType: "rolling", label: "application" }]);
  });

  it("blocks a fixed deadline with no date, next to the date field", async () => {
    const api = mount();

    fireEvent.click(screen.getByRole("button", { name: /\+ Add a deadline/ }));
    submit();

    expect(api.create).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/^Date/).getAttribute("aria-invalid")).toBe("true");
  });
});

describe("the fully-online checkbox", () => {
  it("writes an explicit null location, which is a claim rather than a blank", async () => {
    const api = mount({ fundingType: "hackathon" });

    fireEvent.click(screen.getByLabelText(/Fully online/));
    // The location box goes away: the claim and the value are alternatives.
    expect(screen.queryByLabelText("Location — optional")).toBeNull();
    submit();

    await waitFor(() => expect(api.create).toHaveBeenCalled());
    const details = detailsOf(api);
    expect("location" in details).toBe(true);
    expect(details.location).toBeNull();
  });

  it("leaves the member out entirely when nobody answered", async () => {
    const api = mount({ fundingType: "hackathon" });
    submit();

    await waitFor(() => expect(api.create).toHaveBeenCalled());
    expect("location" in detailsOf(api)).toBe(false);
  });
});

describe("the id", () => {
  it("is derived from the organisation slug and the title until somebody types over it", () => {
    mount({}, { initial: emptyForm() });

    const id = screen.getByLabelText(/^Id/) as HTMLInputElement;
    const [name, slug] = [screen.getByLabelText("Name"), screen.getByLabelText(/^Slug/)];
    fireEvent.change(name, { target: { value: "Acme Foundation" } });
    fireEvent.change(slug, { target: { value: "acme" } });
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "Round One: Public Goods" },
    });

    expect(valueIn(id)).toBe("acme:round-one-public-goods");

    // Typed over — and it stops following.
    fireEvent.change(id, { target: { value: "acme:my-own-key" } });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Round Two" } });
    expect(valueIn(id)).toBe("acme:my-own-key");
  });

  it("says what will happen to this submission, live", () => {
    mount({}, { initial: emptyForm() });

    fireEvent.change(screen.getByLabelText(/^Id/), { target: { value: "acme:x" } });
    expect(screen.getByText(/immediately, without review/)).toBeTruthy();
    expect(screen.getByText(/verified member of acme/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/^Id/), { target: { value: "beta:x" } });
    expect(screen.getByText(/pending, until a reviewer approves it/)).toBeTruthy();
  });

  it("blocks a namespace that is not the primary operating organisation", () => {
    const api = mount({ id: "beta:round-one" });
    submit();

    expect(api.create).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/^Id/).getAttribute("aria-invalid")).toBe("true");
    expect(
      screen.getAllByText(/must be the primary operating organisation/).length,
    ).toBeGreaterThan(0);
  });

  it("is read-only on an edit, and looks it", () => {
    mount({}, { mode: "edit", initial: fill() });
    const id = screen.getByLabelText(/^Id/);
    expect((id as HTMLInputElement).readOnly).toBe(true);
    expect(screen.getByText(/set when this listing was created/)).toBeTruthy();
  });
});

/**
 * The derived id follows the PRIMARY organisation, and the primary changes on a move or a remove
 * just as surely as on a keystroke.
 *
 * The bug this pins down was self-contradicting: promoting another organisation left the id under
 * the old namespace, and the form's own error then told the publisher to promote the organisation
 * they had just promoted.
 */
describe("the derived id follows the primary organisation", () => {
  /** A fresh form with two operating organisations and an id nobody has typed over. */
  function twoOrganisations() {
    const api = mount({}, { initial: emptyForm() });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Acme Foundation" } });
    fireEvent.change(screen.getByLabelText(/^Slug/), { target: { value: "acme" } });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Round One" } });
    fireEvent.click(screen.getByRole("button", { name: /\+ Add an operating organisation/ }));
    fireEvent.change(nth(screen.getAllByLabelText("Name"), 1), {
      target: { value: "Beta Collective" },
    });
    fireEvent.change(nth(screen.getAllByLabelText(/^Slug/), 1), { target: { value: "beta" } });
    expect(valueIn(screen.getByLabelText(/^Id/))).toBe("acme:round-one");
    return api;
  }

  it("regenerates when another organisation is moved to the top", () => {
    twoOrganisations();
    fireEvent.click(nth(screen.getAllByRole("button", { name: /^Move up/ }), 1));
    expect(valueIn(screen.getByLabelText(/^Id/))).toBe("beta:round-one");
    // And the form does not then complain about the id it just wrote.
    submit();
    expect(screen.getByLabelText(/^Id/).getAttribute("aria-invalid")).toBeNull();
  });

  it("regenerates when the current primary is removed", () => {
    twoOrganisations();
    fireEvent.click(nth(screen.getAllByRole("button", { name: /^Remove/ }), 0));
    expect(valueIn(screen.getByLabelText(/^Id/))).toBe("beta:round-one");
  });

  it("regenerates when the primary's slug is edited, as it always did", () => {
    twoOrganisations();
    fireEvent.change(nth(screen.getAllByLabelText(/^Slug/), 0), { target: { value: "acme-two" } });
    expect(valueIn(screen.getByLabelText(/^Id/))).toBe("acme-two:round-one");
  });

  it("NEVER clobbers a hand-typed id, whichever operation moves the primary", () => {
    twoOrganisations();
    fireEvent.change(screen.getByLabelText(/^Id/), { target: { value: "acme:my-own-key" } });

    fireEvent.click(nth(screen.getAllByRole("button", { name: /^Move up/ }), 1));
    expect(valueIn(screen.getByLabelText(/^Id/))).toBe("acme:my-own-key");

    fireEvent.click(nth(screen.getAllByRole("button", { name: /^Remove/ }), 0));
    expect(valueIn(screen.getByLabelText(/^Id/))).toBe("acme:my-own-key");
  });
});

describe("replacing a claimed listing", () => {
  /** An imported id, published under and operated by the organisation that claimed it. */
  const claimed = {
    specVersion: "1.0.0",
    id: "host:123",
    fundingType: "grant",
    title: "Round One",
    description: "A description.",
    status: "open",
    operatingOrganizations: [{ name: "Acme Foundation", slug: "acme" }],
    source: { publisher: "acme", ingestedVia: "import" },
    fundingDetails: { fundingType: "grant" },
  } as unknown as Opportunity;

  function editClaimed() {
    const api = stub(outcome({ created: false }));
    const { form, carried } = fromDocument(claimed);
    render(
      <ApiClientProvider value={api.client}>
        <OpportunityForm
          mode="edit"
          initial={form}
          carried={carried}
          authority={{ verifiedNamespaces: ["acme"], directCreate: false }}
        />
      </ApiClientProvider>,
    );
    return api;
  }

  it("does not block the replace over an id it cannot change", async () => {
    const api = editClaimed();
    fireEvent.click(screen.getByRole("button", { name: "Replace" }));

    // Checked before the outcome panel replaces the form: the id was never marked wrong, and the
    // PUT went. The old behaviour marked it and sent nothing.
    expect(screen.queryByRole("alert")).toBeNull();
    await waitFor(() => expect(api.replace).toHaveBeenCalledWith("host:123", expect.anything()));
  });

  it("predicts the outcome from the stored publisher, not from the id prefix", () => {
    editClaimed();
    // `host` is not a verified namespace of this account; `acme` is, and `acme` is what decides.
    expect(screen.getByText(/immediately, without review/)).toBeTruthy();
    expect(screen.getByText(/verified member of acme/)).toBeTruthy();
    expect(screen.getByText(/not the id/)).toBeTruthy();
  });

  it("blocks only the thing the API actually blocks — dropping the publisher", () => {
    const api = editClaimed();
    fireEvent.change(screen.getByLabelText(/^Slug/), { target: { value: "beta" } });
    fireEvent.click(screen.getByRole("button", { name: "Replace" }));

    expect(api.replace).not.toHaveBeenCalled();
    expect(screen.getAllByText(/published under acme/).length).toBeGreaterThan(0);
  });
});

/**
 * NO HUE CARRIES STATE on this site, so `--ok` and `--bad` resolve to plain `--ink` and `--warn` to
 * `--ink-soft`. That makes every state distinction on this form structural — weight, a rule in the
 * margin, a border style — and structural distinctions are the kind a component can lose silently
 * by handing two states the same class.
 */
describe("the states are told apart without a hue", () => {
  const consequenceClass = () => document.querySelector(`.${styles.consequence}`)?.className ?? "";

  it("gives publishes-now, publishes-later and not-knowable three different treatments", () => {
    const seen: string[] = [];

    const api = stub();
    const show = (
      id: string,
      account?: { verifiedNamespaces: string[]; directCreate: boolean },
    ) => {
      const view = render(
        <ApiClientProvider value={api.client}>
          <OpportunityForm mode="create" initial={fill({ id })} authority={account} />
        </ApiClientProvider>,
      );
      seen.push(consequenceClass());
      view.unmount();
    };

    show("acme:x", { verifiedNamespaces: ["acme"], directCreate: false });
    show("beta:x", { verifiedNamespaces: ["acme"], directCreate: false });
    show("acme:x", undefined);

    expect(seen[0]).toContain(styles.consequenceNow);
    expect(seen[1]).toContain(styles.consequenceLater);
    expect(seen[2]).not.toContain(styles.consequenceNow);
    expect(seen[2]).not.toContain(styles.consequenceLater);
    // Three states, three renderings — none of them collapsed into another.
    expect(new Set(seen).size).toBe(3);
  });

  it("keeps a blocking problem and a non-blocking advisory on different classes", () => {
    // Both resolve to the ink family; the module separates them by weight and by a marginal rule.
    mount({ title: "", applicationUrl: "" });
    submit();

    const problem = document.querySelector(`.${styles.problem}`);
    const advisory = document.querySelector(`.${styles.advisory}`);
    expect(problem).not.toBeNull();
    expect(advisory).not.toBeNull();
    expect(problem?.className).not.toBe(advisory?.className);
  });
});

describe("the primary action", () => {
  it("carries the site-wide primary treatment rather than a local copy of it", () => {
    mount();
    expect(screen.getByRole("button", { name: "Submit" }).className).toContain("button-primary");
  });

  it("is the only filled button on the form", () => {
    mount();
    const filled = screen
      .getAllByRole("button")
      .filter((button) => button.className.includes("button-primary"));
    expect(filled).toHaveLength(1);
  });
});

describe("when problems appear", () => {
  it("holds the summary panel until the publisher has actually tried to submit", () => {
    const api = mount({ title: "" });

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("A title is required.")).toBeNull();

    submit();

    expect(api.create).not.toHaveBeenCalled();
    const panel = screen.getByRole("alert");
    expect(within(panel).getByText(/Fix these fields before submitting/)).toBeTruthy();
    expect(screen.getAllByText("A title is required.").length).toBeGreaterThan(0);
  });

  it("shows a single field's problem as soon as that field is left alone", () => {
    mount({ logoUrl: "example.org" });

    expect(screen.queryByText(/full URL/)).toBeNull();
    fireEvent.blur(screen.getByLabelText("Logo URL — optional"));

    expect(screen.getByText(/full URL/)).toBeTruthy();
    // Still no summary panel: nothing has been submitted.
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps Submit live, because a disabled button says nothing", () => {
    mount({ title: "" });
    expect((screen.getByRole("button", { name: "Submit" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });
});

describe("drafts and dirty navigation", () => {
  it("offers an account's stored draft without silently replacing the blank form", () => {
    localStorage.clear();
    writeOpportunityDraft(7, fill({ title: "Restored title" }));

    mount({}, { initial: emptyForm(), accountId: 7 });

    expect(valueIn(screen.getByLabelText("Title"))).toBe("");
    expect(screen.getByText(/Draft saved on this device/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Restore draft" }));
    expect(valueIn(screen.getByLabelText("Title"))).toBe("Restored title");
    localStorage.clear();
  });

  it("discards a stored draft and never offers another account's draft", () => {
    localStorage.clear();
    writeOpportunityDraft(8, fill({ title: "Another account" }));
    const isolated = mount({}, { initial: emptyForm(), accountId: 7 });
    expect(screen.queryByRole("button", { name: "Restore draft" })).toBeNull();
    isolated.unmount();
    localStorage.clear();

    writeOpportunityDraft(7, fill({ title: "Discard me" }));
    const view = mount({}, { initial: emptyForm(), accountId: 7 });
    fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
    expect(localStorage.getItem(opportunityDraftKey(7))).toBeNull();
    expect(valueIn(screen.getByLabelText("Title"))).toBe("");
    view.unmount();
    localStorage.clear();
  });

  it("shows a storage fallback instead of throwing", () => {
    localStorage.clear();
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("Storage blocked");
    });
    mount({}, { initial: emptyForm(), accountId: 7 });
    expect(screen.getByText(/Draft saving is unavailable/)).toBeTruthy();
    getItem.mockRestore();
  });

  it("flushes the last keystroke synchronously when the form unmounts", () => {
    localStorage.clear();
    const view = mount({}, { initial: emptyForm(), accountId: 7 });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Last keystroke" } });
    view.unmount();

    const restored = readOpportunityDraft(7);
    expect(restored.kind).toBe("draft");
    if (restored.kind === "draft") expect(restored.form.title).toBe("Last keystroke");
    localStorage.clear();
  });

  it("clears the create draft only after a successful submission", async () => {
    localStorage.clear();
    writeOpportunityDraft(7, fill({ title: "Ready to send" }));
    mount({}, { initial: emptyForm(), accountId: 7 });
    fireEvent.click(screen.getByRole("button", { name: "Restore draft" }));
    submit();

    await waitFor(() => expect(screen.getByText("Submitted.")).toBeTruthy());
    expect(localStorage.getItem(opportunityDraftKey(7))).toBeNull();
  });

  it("guards a dirty edit's Cancel link and its unload boundary", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    mount({}, { mode: "edit", initial: fill() });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Changed" } });

    const unload = new Event("beforeunload", { cancelable: true });
    expect(window.dispatchEvent(unload)).toBe(false);
    fireEvent.click(screen.getByRole("link", { name: "Cancel" }));
    expect(confirm).toHaveBeenCalledTimes(1);
    confirm.mockRestore();
  });

  it("unblocks internal links after a successful replacement", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const api = mount({}, { mode: "edit", initial: fill() });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Changed" } });
    fireEvent.click(screen.getByRole("button", { name: "Replace" }));

    await waitFor(() => expect(api.replace).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("link", { name: "Open this listing" }));
    expect(confirm).not.toHaveBeenCalled();
    confirm.mockRestore();
  });
});

describe("after a submission", () => {
  it("replaces the form, so the same opportunity cannot be sent twice", async () => {
    const api = mount();
    submit();

    await waitFor(() => expect(screen.getByText("Submitted.")).toBeTruthy());
    expect(screen.getByText("Live", { selector: ".badge-live" })).toBeTruthy();
    expect(api.create).toHaveBeenCalledTimes(1);
    // The whole form is gone — there is no second Submit to press.
    expect(screen.queryByRole("button", { name: "Submit" })).toBeNull();
    expect(screen.queryByLabelText("Title")).toBeNull();
    expect(screen.getByRole("link", { name: "Open this listing" }).getAttribute("href")).toBe(
      "/listings/acme%3Around-one",
    );
  });

  it("says a pending submission is invisible, rather than implying it is live", async () => {
    const api = stub(outcome({ reviewStatus: "pending", isListed: false }));
    render(
      <ApiClientProvider value={api.client}>
        <OpportunityForm mode="create" initial={fill()} />
      </ApiClientProvider>,
    );
    submit();

    await waitFor(() => expect(screen.getByText(/Stored as a pending submission/)).toBeTruthy());
    expect(screen.getByText("Waiting for review", { selector: ".badge-pending" })).toBeTruthy();
  });

  it("calls an approved but unlisted submission hidden rather than live", async () => {
    const api = stub(outcome({ reviewStatus: "approved", isListed: false }));
    render(
      <ApiClientProvider value={api.client}>
        <OpportunityForm mode="create" initial={fill()} />
      </ApiClientProvider>,
    );
    submit();

    await waitFor(() => expect(screen.getByText("Hidden from directory")).toBeTruthy());
    expect(screen.getByText("Approved, but hidden from the public directory.")).toBeTruthy();
  });

  it("offers a fresh form rather than the one that was just sent", async () => {
    mount();
    submit();

    await waitFor(() => expect(screen.getByText("Submitted.")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Submit another" }));

    expect(valueIn(screen.getByLabelText("Title"))).toBe("");
    expect(valueIn(screen.getByLabelText(/^Id/))).toBe("");
  });

  it("offers the edit back, rather than a blank form, after a replace", async () => {
    const api = stub(outcome({ created: false }));
    const stored = {
      specVersion: "1.0.0",
      id: "acme:round-one",
      fundingType: "grant",
      title: "Round One",
      description: "A description.",
      status: "open",
      operatingOrganizations: [{ name: "Acme Foundation", slug: "acme" }],
      source: {},
      fundingDetails: { fundingType: "grant" },
    } as unknown as Opportunity;
    const { form, carried } = fromDocument(stored);
    render(
      <ApiClientProvider value={api.client}>
        <OpportunityForm mode="edit" initial={form} carried={carried} />
      </ApiClientProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Replace" }));
    await waitFor(() => expect(screen.getByText("Replaced.")).toBeTruthy());
    expect(api.replace).toHaveBeenCalledWith("acme:round-one", expect.anything());

    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(valueIn(screen.getByLabelText("Title"))).toBe("Round One");
  });
});

describe("the repeating groups", () => {
  it("adds and removes an operating organisation", () => {
    mount();

    expect(screen.getAllByLabelText("Name")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: /\+ Add an operating organisation/ }));
    expect(screen.getAllByLabelText("Name")).toHaveLength(2);

    fireEvent.click(nth(screen.getAllByRole("button", { name: /^Remove/ }), 1));
    expect(screen.getAllByLabelText("Name")).toHaveLength(1);
  });

  it("reorders the two lists whose order means something, and only those", async () => {
    const api = mount();

    fireEvent.click(screen.getByRole("button", { name: /\+ Add an operating organisation/ }));
    const names = screen.getAllByLabelText("Name");
    fireEvent.change(nth(names, 1), { target: { value: "Beta Collective" } });
    fireEvent.change(nth(screen.getAllByLabelText(/^Slug/), 1), { target: { value: "beta" } });

    // Beta becomes the primary, which is the whole meaning of position 0.
    fireEvent.click(nth(screen.getAllByRole("button", { name: /^Move up/ }), 1));
    fireEvent.change(screen.getByLabelText(/^Id/), { target: { value: "beta:round-one" } });
    submit();

    await waitFor(() => expect(api.create).toHaveBeenCalled());
    const orgs = sent(api).operatingOrganizations as Record<string, unknown>[];
    expect(orgs.map((org) => org.slug)).toEqual(["beta", "acme"]);
  });

  it("gives a social link no arrows, because its order carries no meaning", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: /\+ Add a link/ }));
    const url = screen.getByLabelText("URL");
    const row = url.closest("div[class]")?.parentElement as HTMLElement;
    expect(within(row).queryByRole("button", { name: /^Move up/ })).toBeNull();
  });
});

describe("the application-link advisory", () => {
  const advisory = /readers have no way to apply/;

  it("says the consequence on the types you apply to, without blocking anything", async () => {
    const api = mount({ applicationUrl: "" });

    // Next to the field, and again in the advisory list — the same two places an error appears.
    expect(screen.getAllByText(advisory).length).toBe(2);
    // Not an error: the field is valid and the submission goes.
    expect(screen.getByLabelText(/^Application URL/).getAttribute("aria-invalid")).toBeNull();

    submit();
    await waitFor(() => expect(api.create).toHaveBeenCalled());
    expect("applicationUrl" in sent(api)).toBe(false);
  });

  it("goes away once there is a link", () => {
    mount({ applicationUrl: "https://example.org/apply" });
    expect(screen.queryByText(advisory)).toBeNull();
  });

  it("says nothing on a fund, which legitimately has no application link", () => {
    mount({ fundingType: "vc_fund", applicationUrl: "" });
    expect(screen.queryByText(advisory)).toBeNull();
  });

  it("says nothing on an accelerator either", () => {
    mount({ fundingType: "accelerator", applicationUrl: "" });
    expect(screen.queryByText(advisory)).toBeNull();
  });

  it("appears and disappears as the funding type changes", () => {
    mount({ fundingType: "vc_fund", applicationUrl: "" });
    expect(screen.queryByText(advisory)).toBeNull();
    fireEvent.change(screen.getByLabelText("Funding type"), { target: { value: "hackathon" } });
    expect(screen.getAllByText(advisory).length).toBe(2);
  });
});

describe("advisory warnings", () => {
  it("are shown in their own list, not as errors, and do not block a submission", async () => {
    // A milestone amount with no document-wide currency is the validator's own advisory check.
    const form = fill();
    form.milestones = [{ key: "m1", title: "Ship it", amount: "50000", criteria: "", base: {} }];
    const api = mount({}, { initial: form });

    const advisory = screen.getByText(/Things to review/);
    expect(advisory).toBeTruthy();
    expect(advisory.closest(".state")?.classList.contains("error")).toBe(false);

    submit();
    await waitFor(() => expect(api.create).toHaveBeenCalled());
  });
});
