import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/dom";
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

function fillPurchaseForm(overrides: Partial<{ item: string; amount: string; category: string; date: string; account: string }> = {}): void {
  const values = { item: "New shoes", amount: "300000", category: "Shopping", date: "2026-09-25", account: "Cash", ...overrides };
  fireEvent.input(screen.getByLabelText("Item"), { target: { value: values.item } });
  fireEvent.input(screen.getByLabelText("Amount"), { target: { value: values.amount } });
  fireEvent.change(screen.getByLabelText("Category"), { target: { value: values.category } });
  fireEvent.input(screen.getByLabelText("Planned date"), { target: { value: values.date } });
  fireEvent.change(screen.getByLabelText("Payment account"), { target: { value: values.account } });
}

function mount(runner: ScriptRunner, bootstrap: PlanningStateView = bootstrapFixture()) {
  const { store, api } = createApp(runner);
  mountShell(root(), store);
  store.setState({ status: "ready", bootstrap, error: null });
  return { store, api };
}

beforeEach(() => {
  resetViewRegistry();
  resetApp();
});

describe("plan-view: purchase result", () => {
  it("shows exact failed guardrails and correction amounts", async () => {
    const checkPurchaseRpc = vi.fn().mockResolvedValue(
      ok({
        decision: {
          verdict: "NOT_RECOMMENDED",
          category: { passed: false, shortfall: 50001 },
          savings: { passed: true, shortfall: 0 },
          household: { passed: true, shortfall: 0 },
          account: { passed: true, shortfall: 0 },
          safeDailyAllowance: 20000,
          failedGuardrails: ["CATEGORY_AVAILABILITY"],
          firstFailure: "CATEGORY_AVAILABILITY",
        },
        corrections: [{ kind: "LOWER_PRICE", amount: 199999 }],
      }),
    );
    mount(fakeRunner({ checkPurchaseRpc }));

    fillPurchaseForm();
    fireEvent.click(screen.getByRole("button", { name: "Check this purchase" }));

    await waitFor(() => expect(screen.getByText(/Shopping budget is short by Rp50\.001/i)).toBeTruthy());
    expect(screen.getByText(/Lower the price to Rp199\.999/i)).toBeTruthy();
    expect(screen.getByText("Verdict: Not recommended")).toBeTruthy();
  });

  it("requires confirmation and a reason before override is allowed", async () => {
    const checkPurchaseRpc = vi.fn().mockResolvedValue(
      ok({
        decision: {
          verdict: "NOT_RECOMMENDED",
          category: { passed: false, shortfall: 50001 },
          savings: { passed: true, shortfall: 0 },
          household: { passed: true, shortfall: 0 },
          account: { passed: true, shortfall: 0 },
          safeDailyAllowance: 20000,
          failedGuardrails: ["CATEGORY_AVAILABILITY"],
          firstFailure: "CATEGORY_AVAILABILITY",
        },
        corrections: [],
      }),
    );
    const overridePurchaseRpc = vi.fn().mockResolvedValue(
      ok({
        actionId: "action-1",
        result: {
          actionId: "action-1",
          item: "New shoes",
          category: "Shopping",
          paymentAccount: "Cash",
          amount: 300000,
          plannedDate: "2026-09-25",
          status: "OVERRIDDEN",
          verdict: "NOT_RECOMMENDED",
          failedGuardrails: ["CATEGORY_AVAILABILITY"],
          overrideReason: "Needed for work",
          createdAt: "2026-09-24T00:00:00+07:00",
          completedAt: null,
        },
        planningState: bootstrapFixture({ safeToPlanAmount: 450000 }),
      }),
    );
    mount(fakeRunner({ checkPurchaseRpc, overridePurchaseRpc }));

    fillPurchaseForm();
    fireEvent.click(screen.getByRole("button", { name: "Check this purchase" }));
    await waitFor(() => expect(screen.getByText("Verdict: Not recommended")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Save with override" }));

    const confirmButton = screen.getByRole("button", { name: "Confirm override" }) as HTMLButtonElement;
    expect(confirmButton.disabled).toBe(true);

    fireEvent.input(screen.getByLabelText("Reason"), { target: { value: "Needed for work" } });
    expect(confirmButton.disabled).toBe(false);

    fireEvent.click(confirmButton);

    await waitFor(() => expect(overridePurchaseRpc).toHaveBeenCalled());
    expect(overridePurchaseRpc).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "Needed for work", item: "New shoes" }),
    );
  });

  it("does not resubmit while an override is pending, and reuses the same actionId on a failed-then-retried submit", async () => {
    const checkPurchaseRpc = vi.fn().mockResolvedValue(
      ok({
        decision: {
          verdict: "NOT_RECOMMENDED",
          category: { passed: false, shortfall: 1000 },
          savings: { passed: true, shortfall: 0 },
          household: { passed: true, shortfall: 0 },
          account: { passed: true, shortfall: 0 },
          safeDailyAllowance: 0,
          failedGuardrails: ["CATEGORY_AVAILABILITY"],
          firstFailure: "CATEGORY_AVAILABILITY",
        },
        corrections: [],
      }),
    );
    let firstAttemptActionId: string | undefined;
    const overridePurchaseRpc = vi.fn().mockImplementation((command: { actionId: string }) => {
      if (!firstAttemptActionId) {
        firstAttemptActionId = command.actionId;
        return Promise.reject({ code: "LOCK_TIMEOUT", message: "Try again." });
      }
      return Promise.resolve(
        ok({
          actionId: command.actionId,
          result: {
            actionId: command.actionId,
            item: "New shoes",
            category: "Shopping",
            paymentAccount: "Cash",
            amount: 300000,
            plannedDate: "2026-09-25",
            status: "OVERRIDDEN",
            verdict: "NOT_RECOMMENDED",
            failedGuardrails: ["CATEGORY_AVAILABILITY"],
            overrideReason: "Needed",
            createdAt: "2026-09-24T00:00:00+07:00",
            completedAt: null,
          },
          planningState: bootstrapFixture(),
        }),
      );
    });
    mount(fakeRunner({ checkPurchaseRpc, overridePurchaseRpc }));

    fillPurchaseForm();
    fireEvent.click(screen.getByRole("button", { name: "Check this purchase" }));
    await waitFor(() => expect(screen.getByText("Verdict: Not recommended")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Save with override" }));
    fireEvent.input(screen.getByLabelText("Reason"), { target: { value: "Needed" } });
    const confirmButton = screen.getByRole("button", { name: "Confirm override" });
    fireEvent.click(confirmButton);

    await waitFor(() => expect(overridePurchaseRpc).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText(/Try again\./)).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Save with override" }));
    fireEvent.input(screen.getByLabelText("Reason"), { target: { value: "Needed" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm override" }));

    await waitFor(() => expect(overridePurchaseRpc).toHaveBeenCalledTimes(2));
    const [firstCall, secondCall] = overridePurchaseRpc.mock.calls;
    expect((secondCall[0] as { actionId: string }).actionId).toBe((firstCall[0] as { actionId: string }).actionId);
  });
});

describe("plan-view: active reservation actions", () => {
  it("lets the user cancel or complete a reservation made this session", async () => {
    const reservePurchaseRpc = vi.fn().mockResolvedValue(
      ok({
        actionId: "action-2",
        result: {
          actionId: "action-2",
          item: "Groceries",
          category: "Dining",
          paymentAccount: "Cash",
          amount: 100000,
          plannedDate: "2026-09-26",
          status: "RESERVED",
          verdict: "RECOMMENDED",
          failedGuardrails: [],
          overrideReason: "",
          createdAt: "2026-09-24T00:00:00+07:00",
          completedAt: null,
        },
        planningState: bootstrapFixture({ safeToPlanAmount: 650000 }),
      }),
    );
    const checkPurchaseRpc = vi.fn().mockResolvedValue(
      ok({
        decision: {
          verdict: "RECOMMENDED",
          category: { passed: true, shortfall: 0 },
          savings: { passed: true, shortfall: 0 },
          household: { passed: true, shortfall: 0 },
          account: { passed: true, shortfall: 0 },
          safeDailyAllowance: 50000,
          failedGuardrails: [],
          firstFailure: null,
        },
        corrections: [],
      }),
    );
    const completePlanRpc = vi.fn().mockResolvedValue(
      ok({
        actionId: "action-2",
        result: {
          actionId: "action-2",
          item: "Groceries",
          category: "Dining",
          paymentAccount: "Cash",
          amount: 100000,
          plannedDate: "2026-09-26",
          status: "COMPLETED",
          verdict: "RECOMMENDED",
          failedGuardrails: [],
          overrideReason: "",
          createdAt: "2026-09-24T00:00:00+07:00",
          completedAt: "2026-09-26T00:00:00+07:00",
        },
        planningState: bootstrapFixture({ safeToPlanAmount: 650000 }),
      }),
    );
    mount(fakeRunner({ checkPurchaseRpc, reservePurchaseRpc, completePlanRpc }));

    fillPurchaseForm({ item: "Groceries", amount: "100000", category: "Dining" });
    fireEvent.click(screen.getByRole("button", { name: "Check this purchase" }));
    await waitFor(() => expect(screen.getByText("Verdict: Recommended")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Reserve this purchase" }));
    await waitFor(() => expect(reservePurchaseRpc).toHaveBeenCalled());

    await waitFor(() => expect(screen.getByText(/Groceries: Rp100\.000/)).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Mark purchased" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm complete" }));

    await waitFor(() => expect(completePlanRpc).toHaveBeenCalledWith(expect.objectContaining({ actionId: "action-2" })));
  });
});

describe("plan-view: expected income", () => {
  it("lets the user mark a session-created expected income entry as received, after confirming", async () => {
    const createExpectedIncomeRpc = vi.fn().mockResolvedValue(
      ok({
        actionId: "income-1",
        result: {
          actionId: "income-1",
          expectedDate: "2026-09-28",
          source: "Freelance",
          destinationAccount: "Cash",
          amount: 200000,
          note: "",
          status: "CONFIRMED",
          createdAt: "2026-09-24T00:00:00+07:00",
        },
        planningState: bootstrapFixture({ fundedAmount: 3200000 }),
      }),
    );
    const updateExpectedIncomeRpc = vi.fn().mockResolvedValue(
      ok({
        actionId: "income-1",
        result: {
          actionId: "income-1",
          expectedDate: "2026-09-28",
          source: "Freelance",
          destinationAccount: "Cash",
          amount: 200000,
          note: "",
          status: "RECEIVED",
          createdAt: "2026-09-24T00:00:00+07:00",
        },
        planningState: bootstrapFixture({ fundedAmount: 3200000 }),
      }),
    );
    mount(fakeRunner({ createExpectedIncomeRpc, updateExpectedIncomeRpc }));

    fireEvent.input(screen.getByLabelText("Source"), { target: { value: "Freelance" } });
    fireEvent.change(screen.getByLabelText("Destination account"), { target: { value: "Cash" } });
    fireEvent.input(screen.getByLabelText("Income amount"), { target: { value: "200000" } });
    fireEvent.input(screen.getByLabelText("Expected date"), { target: { value: "2026-09-28" } });

    fireEvent.click(screen.getByRole("button", { name: "Add expected income" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm income" }));

    await waitFor(() => expect(createExpectedIncomeRpc).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText(/Freelance/)).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Mark received" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm received" }));

    await waitFor(() => expect(updateExpectedIncomeRpc).toHaveBeenCalledWith({ actionId: "income-1", status: "RECEIVED" }));
  });
});
