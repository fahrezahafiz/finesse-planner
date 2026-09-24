import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, screen } from "@testing-library/dom";
import { mountShell, registerView, resetViewRegistry } from "../../src/client/render";
import { createStore } from "../../src/client/state";
import type { ClientState } from "../../src/client/state";
import type { PlanningStateView } from "../../src/server/view-models";

function root(): HTMLElement {
  document.body.innerHTML = "";
  const container = document.createElement("div");
  container.id = "app";
  document.body.appendChild(container);
  return container;
}

function bootstrapFixture(overrides: Partial<PlanningStateView> = {}): PlanningStateView {
  return {
    month: "2026-09",
    health: "HEALTHY",
    planningDate: "2026-09-24",
    daysRemaining: 6,
    protectedSavings: 500000,
    fundedAmount: 3000000,
    safeToPlanAmount: 750000,
    categories: [],
    accounts: [],
    activeReservations: [],
    ...overrides,
  };
}

function readyState(overrides: Partial<ClientState> = {}): Partial<ClientState> {
  return { status: "ready", bootstrap: bootstrapFixture(), error: null, ...overrides };
}

/** Clicks the nav button labeled `label` and returns the resulting view heading. */
function navigate(label: string): HTMLElement {
  fireEvent.click(screen.getByRole("button", { name: label }));
  return screen.getByRole("heading", { level: 1 });
}

beforeEach(() => {
  resetViewRegistry();
});

describe("client shell navigation", () => {
  it("renders four labeled navigation destinations", () => {
    mountShell(root(), createStore(readyState()));

    expect(screen.getAllByRole("button").map(button => button.textContent)).toEqual(
      expect.arrayContaining(["Plan", "Budgets", "Transfers", "History"]),
    );
  });

  it("moves focus to the view heading after navigation", () => {
    mountShell(root(), createStore(readyState()));

    navigate("Budgets");

    expect(document.activeElement?.textContent).toBe("Budgets");
  });

  it("does not move focus on the initial render", () => {
    mountShell(root(), createStore(readyState()));

    const heading = screen.getByRole("heading", { level: 1 });
    expect(document.activeElement).not.toBe(heading);
  });

  it("marks only the active nav button with aria-current", () => {
    mountShell(root(), createStore(readyState()));

    expect(screen.getByRole("button", { name: "Plan" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("button", { name: "Budgets" }).getAttribute("aria-current")).toBeNull();

    navigate("Transfers");

    expect(screen.getByRole("button", { name: "Transfers" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("button", { name: "Plan" }).getAttribute("aria-current")).toBeNull();
  });

  it("renders exactly one h1 for the active view", () => {
    mountShell(root(), createStore(readyState()));

    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);

    navigate("History");

    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });

  it("includes a skip link targeting the main content landmark", () => {
    mountShell(root(), createStore(readyState()));

    const link = screen.getByText("Skip to content");
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toBe("#main-content");
    expect(document.getElementById("main-content")?.tagName).toBe("MAIN");
  });
});

describe("client shell loading and error states", () => {
  it("announces loading via the aria-live status region before bootstrap resolves", () => {
    mountShell(root(), createStore({ status: "loading", bootstrap: null, error: null }));

    const status = screen.getByRole("status");
    expect(status.textContent).toMatch(/loading/i);
  });

  it("announces an error via the status region and does not render bootstrap-driven content", () => {
    mountShell(
      root(),
      createStore({
        status: "error",
        bootstrap: null,
        error: { code: "INTERNAL_ERROR", message: "The request could not be completed." },
      }),
    );

    expect(screen.getByRole("status").textContent).toMatch(/could not be completed/i);
    const errorText = document.querySelector<HTMLElement>(".error-text");
    expect(errorText?.textContent).toMatch(/could not be completed/i);
    expect(screen.queryByText(/Active reservations/)).toBeNull();
  });

  it("clears the status region once ready", () => {
    const store = createStore({ status: "loading", bootstrap: null, error: null });
    mountShell(root(), store);

    store.setState(readyState());

    expect(screen.getByRole("status").textContent).toBe("");
  });
});

describe("client shell placeholder content", () => {
  it("shows an empty state when there are no active reservations", () => {
    mountShell(root(), createStore(readyState({ bootstrap: bootstrapFixture({ activeReservations: [] }) })));

    expect(screen.getByText("No active reservations yet.")).toBeTruthy();
  });

  it("lists active reservations with IDR-formatted amounts and formatted dates", () => {
    mountShell(
      root(),
      createStore(
        readyState({
          bootstrap: bootstrapFixture({
            activeReservations: [{ actionId: "plan-1", amount: 50001, paymentAccount: "BCA", plannedDate: "2026-09-25" }],
          }),
        }),
      ),
    );

    expect(screen.getByText(/Rp50\.001/)).toBeTruthy();
    expect(screen.getByText(/25 Sep 2026/)).toBeTruthy();
  });
});

describe("view registration extension point", () => {
  it("lets a caller register a renderer that replaces the placeholder for one view", () => {
    registerView("budgets", container => {
      const marker = document.createElement("p");
      marker.textContent = "Custom budgets view";
      container.appendChild(marker);
    });

    mountShell(root(), createStore(readyState()));
    navigate("Budgets");

    expect(screen.getByText("Custom budgets view")).toBeTruthy();
  });

  it("leaves unregistered views on the default placeholder", () => {
    registerView("budgets", container => {
      const marker = document.createElement("p");
      marker.textContent = "Custom budgets view";
      container.appendChild(marker);
    });

    mountShell(root(), createStore(readyState()));

    expect(screen.getByText("Active reservations")).toBeTruthy();
    expect(screen.queryByText("Custom budgets view")).toBeNull();
  });
});
