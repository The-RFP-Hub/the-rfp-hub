import { readFileSync } from "node:fs";
import { join } from "node:path";
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
import { PublisherJourney } from "@/components/PublisherJourney";
import { type ApiClient, ApiError } from "@/lib/api";
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
  emptyRewardTier,
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
    duplicateCheck: "ok",
    duplicates: [],
    ...over,
  } as SubmissionResult;
}

function stub(result: SubmissionResult | Error = outcome()) {
  const respond = async () => {
    if (result instanceof Error) throw result;
    return result;
  };
  const create = vi.fn(respond);
  const replace = vi.fn(respond);
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
  options: {
    mode?: "create" | "edit";
    initial?: OpportunityFormState;
    accountId?: number;
    result?: SubmissionResult | Error;
  } = {},
) {
  const api = stub(options.result);
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

  it("takes local time and previews the stored UTC instant beside it", () => {
    mount({ opensAt: "2026-09-30T23:59" });

    expect(screen.getByLabelText("Applications open — optional", { exact: true })).toBeTruthy();
    expect(screen.queryByLabelText(/Applications open.*UTC/)).toBeNull();
    expect(screen.getByText("= 2026-10-01 02:59 UTC")).toBeTruthy();
    expect(screen.getAllByText(/Enter local time \(America\/Sao_Paulo, UTC−03:00\)/)).toHaveLength(
      2,
    );
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
  it("is derived from the organization slug and the title until somebody types over it", () => {
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

  it("blocks a namespace that is not the primary operating organization", () => {
    const api = mount({ id: "beta:round-one" });
    submit();

    expect(api.create).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/^Id/).getAttribute("aria-invalid")).toBe("true");
    expect(
      screen.getAllByText(/must be the primary operating organization/).length,
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
 * The derived id follows the PRIMARY organization, and the primary changes on a move or a remove
 * just as surely as on a keystroke.
 *
 * The bug this pins down was self-contradicting: promoting another organization left the id under
 * the old namespace, and the form's own error then told the publisher to promote the organization
 * they had just promoted.
 */
describe("the derived id follows the primary organization", () => {
  /** A fresh form with two operating organizations and an id nobody has typed over. */
  function twoOrganizations() {
    const api = mount({}, { initial: emptyForm() });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Acme Foundation" } });
    fireEvent.change(screen.getByLabelText(/^Slug/), { target: { value: "acme" } });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Round One" } });
    fireEvent.click(screen.getByRole("button", { name: /\+ Add an operating organization/ }));
    fireEvent.change(nth(screen.getAllByLabelText("Name"), 1), {
      target: { value: "Beta Collective" },
    });
    fireEvent.change(nth(screen.getAllByLabelText(/^Slug/), 1), { target: { value: "beta" } });
    expect(valueIn(screen.getByLabelText(/^Id/))).toBe("acme:round-one");
    return api;
  }

  it("regenerates when another organization is moved to the top", () => {
    twoOrganizations();
    fireEvent.click(nth(screen.getAllByRole("button", { name: /^Move up/ }), 1));
    expect(valueIn(screen.getByLabelText(/^Id/))).toBe("beta:round-one");
    // And the form does not then complain about the id it just wrote.
    submit();
    expect(screen.getByLabelText(/^Id/).getAttribute("aria-invalid")).toBeNull();
  });

  it("regenerates when the current primary is removed", () => {
    twoOrganizations();
    fireEvent.click(nth(screen.getAllByRole("button", { name: /^Remove/ }), 0));
    expect(valueIn(screen.getByLabelText(/^Id/))).toBe("beta:round-one");
  });

  it("regenerates when the primary's slug is edited, as it always did", () => {
    twoOrganizations();
    fireEvent.change(nth(screen.getAllByLabelText(/^Slug/), 0), { target: { value: "acme-two" } });
    expect(valueIn(screen.getByLabelText(/^Id/))).toBe("acme-two:round-one");
  });

  it("NEVER clobbers a hand-typed id, whichever operation moves the primary", () => {
    twoOrganizations();
    fireEvent.change(screen.getByLabelText(/^Id/), { target: { value: "acme:my-own-key" } });

    fireEvent.click(nth(screen.getAllByRole("button", { name: /^Move up/ }), 1));
    expect(valueIn(screen.getByLabelText(/^Id/))).toBe("acme:my-own-key");

    fireEvent.click(nth(screen.getAllByRole("button", { name: /^Remove/ }), 0));
    expect(valueIn(screen.getByLabelText(/^Id/))).toBe("acme:my-own-key");
  });
});

describe("replacing a claimed listing", () => {
  /** An imported id, published under and operated by the organization that claimed it. */
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
 * Every state distinction remains structural — weight, a rule in the margin, a border style — so
 * warning/error hues reinforce rather than carry meaning. Structural distinctions are the kind a
 * component can lose silently by handing two states the same class.
 */
describe("the states remain distinct without relying on hue", () => {
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
    // Both resolve to the ink family; the module separates them by weight and a full-border shape.
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

describe("required fields and intrinsic alignment", () => {
  const expectRequired = (control: HTMLElement) => {
    expect(control.getAttribute("required")).not.toBeNull();
    expect(control.getAttribute("aria-required")).toBe("true");
  };

  it("marks required controls without changing their accessible labels", () => {
    mount();

    for (const name of ["Title", "Funding type", "Description", /^Id/, "Status", "Name", /^Slug/]) {
      expectRequired(screen.getByLabelText(name));
    }
    // The marker is deliberately absent from the accessible name, preserving exact e2e anchors.
    expect(screen.getByLabelText("Title", { exact: true })).toBeTruthy();
    expect(screen.queryByLabelText("Title *", { exact: true })).toBeNull();
    const titleLabel = document.querySelector('label[for="f-title"]') as HTMLLabelElement;
    const marker = titleLabel.parentElement?.querySelector('[aria-hidden="true"]');
    expect(marker?.textContent).toContain("*");

    const summary = screen.getByLabelText("Summary — optional");
    expect(summary.getAttribute("required")).toBeNull();
    expect(summary.getAttribute("aria-required")).toBeNull();
    expect(screen.getByText(/Required/).textContent).toContain("Required");
    expect(screen.getByText(/Running organizations/).textContent).toContain(
      "Running organizations",
    );

    for (const label of [
      "Total budget — optional",
      "Committed — optional",
      "Min award — optional",
      "Max award — optional",
      "Applications open — optional",
      "First announced — optional",
      "Paid against milestones — optional",
      "Runs in recurring rounds — optional",
    ]) {
      expect(screen.getByLabelText(label, { exact: true })).toBeTruthy();
    }
    expect(screen.getByRole("group", { name: "Funding mechanisms — optional" })).toBeTruthy();
  });

  it("marks each conditional row field that becomes required", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: /\+ Add a link/ }));
    expectRequired(screen.getByLabelText("Platform"));
    expectRequired(screen.getByLabelText("URL"));

    fireEvent.click(screen.getByRole("button", { name: /\+ Add a deadline/ }));
    expectRequired(screen.getByLabelText("Deadline kind"));
    expectRequired(screen.getByLabelText("Date"));
    fireEvent.change(screen.getByLabelText("Deadline kind"), { target: { value: "rolling" } });
    expect(screen.queryByLabelText("Date")).toBeNull();

    fireEvent.change(screen.getByLabelText("Funding type"), { target: { value: "hackathon" } });
    fireEvent.click(screen.getByRole("button", { name: /\+ Add a prize/ }));
    expectRequired(screen.getByLabelText("Amount"));

    fireEvent.change(screen.getByLabelText("Funding type"), { target: { value: "bounty" } });
    expectRequired(screen.getByLabelText("Bounty kind"));
    expectRequired(screen.getByLabelText("Compensation"));
    expectRequired(screen.getByLabelText("Reward"));
  });

  it("marks the active payout model's figures, but not optional percentage bounds", () => {
    const form = fill({ fundingType: "bounty" });
    form.details.bounty.bountyKind = "security";
    form.details.bounty.rewardTiers = [emptyRewardTier()];
    mount({}, { initial: form });

    expectRequired(screen.getByLabelText("Payout model, tier 1"));
    expectRequired(screen.getByLabelText("Amount, tier 1"));
    fireEvent.change(screen.getByLabelText("Payout model, tier 1"), {
      target: { value: "percentage" },
    });
    expectRequired(screen.getByLabelText("Percentage, tier 1"));
    expectRequired(screen.getByLabelText("Basis, tier 1"));
    expect(screen.getByLabelText("Floor, tier 1").getAttribute("required")).toBeNull();
    expect(screen.getByLabelText("Cap, tier 1").getAttribute("required")).toBeNull();
  });

  it("aligns paired label/control pairs before their variable-height guidance", () => {
    mount();
    const funding = screen.getByLabelText("Funding type");
    expect(funding.closest(`.${styles.control}`)).not.toBeNull();
    expect(funding.closest(`.${styles.fieldLayout}`)).not.toBeNull();

    const css = readFileSync(
      join(process.cwd(), "src", "components", "OpportunityForm.module.css"),
      "utf8",
    );
    expect(css).toMatch(/\.cols\s*{[^}]*flex-wrap:\s*wrap;[^}]*align-items:\s*flex-start;/s);
    expect(css).toMatch(/\.cols\s*>\s*\*\s*{[^}]*flex:\s*1 1 12rem;/s);
    expect(css).toMatch(/\.fieldLayout\s*{[^}]*flex-direction:\s*column;/s);
    expect(css).not.toMatch(/\.control\s*{[^}]*margin-top:\s*auto;/s);
    expect(css).not.toContain("@media");
  });

  it("groups funding as three totals and two award bounds with field-linked explanations", () => {
    mount();

    const currency = screen.getByLabelText("Currency — optional");
    const committed = screen.getByLabelText("Committed — optional");
    const totals = currency.closest(`.${styles.fundingGrid}`) as HTMLElement;
    const awards = screen
      .getByLabelText("Min award — optional")
      .closest(`.${styles.fundingGrid}`) as HTMLElement;

    expect(totals.querySelectorAll("[data-field-path]")).toHaveLength(3);
    expect(awards.querySelectorAll("[data-field-path]")).toHaveLength(2);
    expect(totals.contains(committed)).toBe(true);
    expect(currency.getAttribute("aria-describedby")).toContain("f-currency-hint");
    expect(committed.getAttribute("aria-describedby")).toContain("f-allocated-hint");
    expect(screen.getByText(/One currency for the whole listing/).id).toBe("f-currency-hint");
    expect(screen.getByText(/What has been promised to date/).id).toBe("f-allocated-hint");
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
    expect(document.activeElement).toBe(panel);
    expect(
      within(panel)
        .getByRole("link", { name: /Title: A title is required/ })
        .getAttribute("href"),
    ).toBe("#f-title");
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

  it("keeps each helper, counter and problem below its own control", () => {
    mount({ title: "" });
    submit();

    const title = screen.getByLabelText("Title") as HTMLInputElement;
    const field = title.closest('[data-field-path="title"]') as HTMLElement;
    const labelRow = title.labels?.[0]?.parentElement as HTMLElement;
    const control = title.closest(`.${styles.control}`) as HTMLElement;
    const helper = within(field).getByText("The name the program is published under.");
    const guidance = helper.closest(`.${styles.guidanceRow}`) as HTMLElement;
    const counter = within(field).getByText("0 / 300");
    const problem = within(field).getByText("A title is required.");
    const children = Array.from(field.children);

    expect(children.indexOf(labelRow)).toBeLessThan(children.indexOf(control));
    expect(children.indexOf(control)).toBeLessThan(children.indexOf(guidance));
    expect(children.indexOf(guidance)).toBeLessThan(children.indexOf(problem));
    expect(guidance.contains(counter)).toBe(true);
    expect(problem.closest("[data-field-path]")).toBe(field);
  });

  it("keeps Submit live, because a disabled button says nothing", () => {
    mount({ title: "" });
    expect((screen.getByRole("button", { name: "Submit" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("links every known API shape and leaves unmapped residue visibly unlinked", async () => {
    const lines = [
      "(root) must be a Standard opportunity",
      "/fundingDetails/programModel grant details: must be a registered value",
      "fundingDetails.fundingType 'hackathon' does not match the opportunity's fundingType 'grant'",
      "`title` must be at most 256 characters (got 300).",
      "An unclassified server validation failure",
    ];
    mount(
      {},
      {
        result: new ApiError(400, "validation_failed", "Invalid listing", { errors: lines }),
      },
    );
    submit();

    const summary = await screen.findByRole("alert");
    // Focus moves in an effect after the alert renders; on a slow runner the render can be
    // observed before the effect has run, so the focus is awaited rather than read once.
    await waitFor(() => expect(document.activeElement).toBe(summary));
    expect(
      within(summary)
        .getByRole("link", { name: /Whole form/ })
        .getAttribute("href"),
    ).toBe("#form-error-summary");
    expect(
      within(summary)
        .getByRole("link", { name: /Program model/ })
        .getAttribute("href"),
    ).toBe("#f-details-grant-programModel");
    expect(
      within(summary)
        .getByRole("link", { name: /Funding type/ })
        .getAttribute("href"),
    ).toBe("#f-fundingType");
    expect(within(summary).getByRole("link", { name: /Title/ }).getAttribute("href")).toBe(
      "#f-title",
    );
    const residue = within(summary).getByText("An unclassified server validation failure");
    expect(residue.closest("a")).toBeNull();
    expect(screen.getByLabelText("Funding type").getAttribute("aria-invalid")).toBe("true");

    const technical = screen.getByText("Technical validation details").closest("details");
    expect(technical).not.toBeNull();
    for (const line of lines) expect(within(technical as HTMLElement).getByText(line)).toBeTruthy();
  });

  it("clears a server issue as soon as its field changes", async () => {
    mount(
      {},
      {
        result: new ApiError(400, "validation_failed", "Invalid listing", {
          errors: ["/title must pass the server title rule"],
          issues: [{ path: "/title", message: "The server rejected this title." }],
        }),
      },
    );
    submit();

    const title = screen.getByLabelText("Title");
    await waitFor(() => expect(title.getAttribute("aria-invalid")).toBe("true"));
    expect(screen.getAllByText("The server rejected this title.").length).toBeGreaterThan(0);

    fireEvent.change(title, { target: { value: "A corrected title" } });

    expect(title.getAttribute("aria-invalid")).toBeNull();
    expect(screen.queryByText("The server rejected this title.")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("drafts and dirty navigation", () => {
  it("offers an account's stored draft without silently replacing the blank form", () => {
    localStorage.clear();
    writeOpportunityDraft(7, fill({ title: "Restored title" }), {
      now: new Date("2026-08-25T20:50:37Z"),
    });

    mount({}, { initial: emptyForm(), accountId: 7 });

    expect(valueIn(screen.getByLabelText("Title"))).toBe("");
    expect(
      screen.getByText((_, node) =>
        Boolean(
          node?.tagName === "P" &&
            node.textContent === "Draft saved on this device on 25 Aug 2026, 20:50 UTC.",
        ),
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Restore draft" }));
    expect(valueIn(screen.getByLabelText("Title"))).toBe("Restored title");
    localStorage.clear();
  });

  it("re-enters the explicit draft choice when a session refresh reuses the form", () => {
    localStorage.clear();
    const initial = emptyForm();
    const api = stub();
    const tree = (accountId: number) => (
      <ApiClientProvider value={api.client}>
        <NavigationBlockerProvider>
          <OpportunityForm mode="create" accountId={accountId} initial={initial} />
        </NavigationBlockerProvider>
      </ApiClientProvider>
    );
    const view = render(tree(6));

    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Current session" } });
    writeOpportunityDraft(7, fill({ title: "Stored for refreshed session" }));
    view.rerender(tree(7));

    expect(valueIn(screen.getByLabelText("Title"))).toBe("");
    expect(screen.getByRole("button", { name: "Restore draft" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Discard draft" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Restore draft" }));
    expect(valueIn(screen.getByLabelText("Title"))).toBe("Stored for refreshed session");
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
    fireEvent.click(screen.getByRole("link", { name: "View it as applicants see it" }));
    expect(confirm).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it("uses the successful replacement as the new dirty baseline", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const api = mount({}, { mode: "edit", initial: fill(), result: outcome({ created: false }) });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Saved title" } });
    fireEvent.click(screen.getByRole("button", { name: "Replace" }));

    await waitFor(() => expect(api.replace).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Continue editing" }));
    expect(valueIn(screen.getByLabelText("Title"))).toBe("Saved title");

    const unload = new Event("beforeunload", { cancelable: true });
    expect(window.dispatchEvent(unload)).toBe(true);
    fireEvent.click(screen.getByRole("link", { name: "Cancel" }));
    expect(confirm).not.toHaveBeenCalled();
    confirm.mockRestore();
  });
});

describe("after a submission", () => {
  it("starts the blank submission journey at Submit", () => {
    render(<PublisherJourney current="submit" />);

    const journey = screen.getByRole("list", { name: "Publishing journey" });
    expect(journey.querySelector('[aria-current="step"]')?.textContent).toBe("Submit");
    expect(within(journey).getAllByRole("listitem")).toHaveLength(3);
  });

  it("replaces the form, so the same opportunity cannot be sent twice", async () => {
    const api = mount();
    submit();

    await waitFor(() => expect(screen.getByText("Submitted.")).toBeTruthy());
    expect(screen.getByText("Live", { selector: ".badge-live" })).toBeTruthy();
    expect(screen.getByText("Round One").closest("strong")).toBeTruthy();
    expect(api.create).toHaveBeenCalledTimes(1);
    const journey = screen.getByRole("list", { name: "Publishing journey" });
    expect(journey.querySelector('[aria-current="step"]')?.textContent).toBe("Live");
    expect(within(journey).getByText("(not required)")).toBeTruthy();
    // The whole form is gone — there is no second Submit to press.
    expect(screen.queryByRole("button", { name: "Submit" })).toBeNull();
    expect(screen.queryByLabelText("Title")).toBeNull();
    const primary = screen.getByRole("link", { name: "View it as applicants see it" });
    const secondary = screen.getByRole("button", { name: "Submit another" });
    expect(primary.getAttribute("href")).toBe("/opportunities/acme%3Around-one");
    expect(primary.className).toContain("button-primary");
    expect(secondary.className).not.toContain("button-primary");
    expect(primary.compareDocumentPosition(secondary) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(
      0,
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
    const journey = screen.getByRole("list", { name: "Publishing journey" });
    expect(journey.querySelector('[aria-current="step"]')?.textContent).toBe("In review");
    expect(within(journey).queryByText("(not required)")).toBeNull();
    expect(screen.getByRole("link", { name: "Open this listing" }).getAttribute("href")).toBe(
      "/listings/acme%3Around-one",
    );
  });

  it("warns visibly about matches and routes each side by its public visibility", async () => {
    mount(
      {},
      {
        result: outcome({
          duplicates: [
            {
              id: "public:earlier round",
              title: "Earlier Public Round",
              isPublic: true,
              similarity: 0.912,
              matchedOn: ["lexical"],
              status: "suspected",
              detectedAt: "2026-08-25T00:00:00Z",
            },
            {
              id: "private:queued round",
              title: "Queued Private Round",
              isPublic: false,
              similarity: 0.86,
              matchedOn: ["lexical"],
              status: "suspected",
              detectedAt: "2026-08-25T00:00:00Z",
            },
          ],
        }),
      },
    );
    submit();

    const warning = await screen.findByRole("heading", { name: "Possible duplicate" });
    expect(warning.closest(`.${styles.duplicateWarning}`)).not.toBeNull();
    expect(screen.getByText("91% similar")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Earlier Public Round" }).getAttribute("href")).toBe(
      "/opportunities/public%3Aearlier%20round",
    );
    expect(screen.getByRole("link", { name: "Queued Private Round" }).getAttribute("href")).toBe(
      "/listings/private%3Aqueued%20round",
    );
    expect(screen.getByText("A reviewer will also see this match.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Withdraw/i })).toBeNull();
    expect(screen.getByRole("link", { name: "View it as applicants see it" })).toBeTruthy();
  });

  it("acknowledges a different program locally without disturbing the success actions", async () => {
    const api = mount(
      {},
      {
        result: outcome({
          reviewStatus: "pending",
          isListed: false,
          duplicates: [
            {
              id: "acme:earlier",
              title: "Earlier Round",
              isPublic: true,
              similarity: 0.9,
              matchedOn: ["lexical"],
              status: "suspected",
              detectedAt: "2026-08-25T00:00:00Z",
            },
          ],
        }),
      },
    );
    submit();

    expect(
      await screen.findByText("A reviewer will compare the pair before publication."),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "This is a different program" }));

    expect(screen.queryByRole("heading", { name: "Possible duplicate" })).toBeNull();
    expect(screen.getByText(/Reviewers will still see the possible match/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open this listing" })).toBeTruthy();
    expect(api.create).toHaveBeenCalledTimes(1);
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
    expect(screen.getByRole("link", { name: "Open this listing" }).getAttribute("href")).toBe(
      "/listings/acme%3Around-one",
    );
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

    expect(
      screen.getByRole("link", { name: "View it as applicants see it" }).getAttribute("href"),
    ).toBe("/opportunities/acme%3Around-one");
    fireEvent.click(screen.getByRole("button", { name: "Continue editing" }));
    expect(valueIn(screen.getByLabelText("Title"))).toBe("Round One");
  });
});

describe("the repeating groups", () => {
  it("adds and removes an operating organization", () => {
    mount();

    expect(screen.getAllByLabelText("Name")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: /\+ Add an operating organization/ }));
    expect(screen.getAllByLabelText("Name")).toHaveLength(2);

    fireEvent.click(nth(screen.getAllByRole("button", { name: /^Remove/ }), 1));
    expect(screen.getAllByLabelText("Name")).toHaveLength(1);
  });

  it("reorders the two lists whose order means something, and only those", async () => {
    const api = mount();

    fireEvent.click(screen.getByRole("button", { name: /\+ Add an operating organization/ }));
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
