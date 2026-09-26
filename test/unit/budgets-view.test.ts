import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/dom";
import { createApp, resetApp } from "../../src/client/client";
import { mountShell, resetViewRegistry } from "../../src/client/render";
import type { ScriptRunner } from "../../src/client/api";
import type { PlanningStateView } from "../../src/server/view-models";

function bootstrapFixture(overrides: Partial<PlanningStateView> = {}): PlanningStateView {
  return {
    month: "2026-09",
    health: "HEALTHY",
    planningDate: "2026-09-24",
    daysRemaining: 6,
    protectedSavings: 500000,
    fundedAmount: 3000000,
    safeToPlanAmount: 750000,
    unallocatedHeadroom: 250000,
    categories: [
      { category: "Shopping", adjustedBudget: 300000, availableBudget: 250000 },
      { category: "Dining", adjustedBudget: 200000, availableBudget: 150000 },
      { category: "Savings", adjustedBudget: 500000, availableBudget: 500000 },
    ],
    accounts: [{ account: "Cash", currentBalance: 500000 }],
    activeReservations: [],
    ...overrides,
  };
}

function root(): HTMLElement {
  document.body.innerHTML = "";
  const container = document.createElement("div");
  container.id = "app";
  document.body.appendChild(container);
  return container;
}

function fakeRunner(handlers: Record<string, (...args: unknown[]) => unknown>): ScriptRunner {
  return {
    run: (functionName: string, ...args: unknown[]) => {
      const handler = handlers[functionName];
      if (!handler) return Promise.reject(new Error(`unexpected RPC call: ${functionName}`));
      return Promise.resolve(handler(...args));
    },
  };
}

function ok<T>(data: T) {
  return { ok: true as const, data };
}

function mount(runner: ScriptRunner, bootstrap: PlanningStateView = bootstrapFixture()) {
  const { store, api } = createApp(runner);
  mountShell(root(), store);
  store.setState({ status: "ready", view: "budgets", bootstrap, error: null });
  return { store, api };
}

beforeEach(() => {
  resetViewRegistry();
  resetApp();
});

describe("budgets-view: category health", () => {
  it("shows remaining amounts and a consumption bar per category, excluding protected savings", () => {
    mount(fakeRunner({}));

    expect(screen.getByText("Rp250.000 remaining of Rp300.000")).toBeTruthy();
    expect(screen.getByText("Rp150.000 remaining of Rp200.000")).toBeTruthy();

    const bars = screen.getAllByRole("progressbar");
    expect(bars).toHaveLength(2); // Shopping + Dining only - Savings is never shown as a spendable category here
    const shoppingBar = bars.find(bar => bar.getAttribute("aria-label") === "Shopping budget consumed")!;
    expect(shoppingBar.getAttribute("aria-valuenow")).toBe(String(Math.round(((300000 - 250000) / 300000) * 100)));

    expect(screen.queryByText("Savings")).toBeNull();
  });

  it("shows an over-budget category as a concrete failure", () => {
    mount(
      fakeRunner({}),
      bootstrapFixture({
        categories: [
          { category: "Shopping", adjustedBudget: 300000, availableBudget: -20000 },
          { category: "Savings", adjustedBudget: 500000, availableBudget: 500000 },
        ],
      }),
    );

    const overBudget = screen.getByText("Rp20.000 over the Rp300.000 budget");
    expect(overBudget.className).toContain("error-text");
  });
});

describe("budgets-view: direct Transfer budget action", () => {
  it("opens an inline transfer form pre-set to the category, shows donor availability, excludes Savings from selectors, and creates the transfer directly (no navigation)", async () => {
    const createTransferRpc = vi.fn().mockResolvedValue(
      ok({
        actionId: "transfer-1",
        result: {
          actionId: "transfer-1",
          fromCategory: "Shopping",
          toCategory: "Dining",
          amount: 50000,
          reason: "Cover dinner",
          relatedPlanId: "",
          status: "ACTIVE",
          createdAt: "2026-09-24T00:00:00+07:00",
          reversalReference: "",
        },
        planningState: bootstrapFixture({
          categories: [
            { category: "Shopping", adjustedBudget: 300000, availableBudget: 200000 },
            { category: "Dining", adjustedBudget: 200000, availableBudget: 200000 },
            { category: "Savings", adjustedBudget: 500000, availableBudget: 500000 },
          ],
        }),
      }),
    );
    mount(fakeRunner({ createTransferRpc }));

    function findShoppingCard(): HTMLElement {
      const card = Array.from(document.querySelectorAll<HTMLElement>("li.card")).find(
        li => li.querySelector(".category-name")?.textContent === "Shopping",
      );
      if (!card) throw new Error("Shopping card not found");
      return card;
    }

    fireEvent.click(within(findShoppingCard()).getByRole("button", { name: "Transfer budget" }));

    // The whole view body re-renders on this local toggle (same closure-rebuild pattern as every
    // other view here), so the card element itself is replaced - re-query it after the click.
    const shoppingCard = findShoppingCard();

    const fromSelect = within(shoppingCard).getByLabelText("From category") as HTMLSelectElement;
    expect(fromSelect.value).toBe("Shopping");

    // Protected savings never appears as a from/to option.
    const fromOptionValues = Array.from(fromSelect.options).map(option => option.value);
    expect(fromOptionValues).not.toContain("Savings");
    const toSelect = within(shoppingCard).getByLabelText("To category") as HTMLSelectElement;
    const toOptionValues = Array.from(toSelect.options).map(option => option.value);
    expect(toOptionValues).not.toContain("Savings");

    // Donor availability is shown before any confirmation step.
    expect(within(shoppingCard).getByText("Shopping has Rp250.000 available.")).toBeTruthy();

    fireEvent.change(toSelect, { target: { value: "Dining" } });
    fireEvent.input(within(shoppingCard).getByLabelText("Amount"), { target: { value: "50000" } });
    fireEvent.input(within(shoppingCard).getByLabelText("Reason"), { target: { value: "Cover dinner" } });

    expect(screen.queryByRole("button", { name: "Confirm transfer" })).toBeNull();

    fireEvent.click(within(shoppingCard).getByRole("button", { name: "Create transfer" }));
    expect(within(shoppingCard).getByText(/Shopping currently has Rp250\.000 available/)).toBeTruthy();

    fireEvent.click(within(shoppingCard).getByRole("button", { name: "Confirm transfer" }));

    await waitFor(() => expect(createTransferRpc).toHaveBeenCalledWith(
      expect.objectContaining({ fromCategory: "Shopping", toCategory: "Dining", amount: 50000, reason: "Cover dinner" }),
    ));
  });
});
