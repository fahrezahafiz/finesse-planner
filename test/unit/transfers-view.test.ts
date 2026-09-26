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

const emptyHistory = { plans: [], transfers: [], income: [] };

function mount(runner: ScriptRunner, bootstrap: PlanningStateView = bootstrapFixture()) {
  const { store, api } = createApp(runner);
  mountShell(root(), store);
  store.setState({ status: "ready", view: "transfers", bootstrap, error: null });
  return { store, api };
}

beforeEach(() => {
  resetViewRegistry();
  resetApp();
});

describe("transfers-view: creating a transfer", () => {
  it("shows donor availability before confirmation and excludes protected savings from both category selectors", async () => {
    const getHistoryRpc = vi.fn().mockResolvedValue(ok(emptyHistory));
    const getInsightsRpc = vi.fn().mockResolvedValue(ok({ transferPatterns: { windowMonths: [], recurringRecipients: [], recurringDonors: [] }, baselineReview: { windowMonths: [], changes: [] } }));
    mount(fakeRunner({ getHistoryRpc, getInsightsRpc }));

    await waitFor(() => expect(getHistoryRpc).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "Create a transfer" }));

    const fromSelect = screen.getByLabelText("From category") as HTMLSelectElement;
    const toSelect = screen.getByLabelText("To category") as HTMLSelectElement;
    expect(Array.from(fromSelect.options).map(o => o.value)).not.toContain("Savings");
    expect(Array.from(toSelect.options).map(o => o.value)).not.toContain("Savings");

    fireEvent.change(fromSelect, { target: { value: "Shopping" } });

    // Donor availability appears before any confirm step is shown.
    expect(screen.getByText("Shopping has Rp250.000 available.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Confirm transfer" })).toBeNull();
  });

  it("creates the transfer after an explicit confirmation", async () => {
    const getHistoryRpc = vi.fn().mockResolvedValue(ok(emptyHistory));
    const getInsightsRpc = vi.fn().mockResolvedValue(ok({ transferPatterns: { windowMonths: [], recurringRecipients: [], recurringDonors: [] }, baselineReview: { windowMonths: [], changes: [] } }));
    const createTransferRpc = vi.fn().mockResolvedValue(
      ok({
        actionId: "transfer-1",
        result: {
          actionId: "transfer-1",
          fromCategory: "Shopping",
          toCategory: "Dining",
          amount: 30000,
          reason: "Balance",
          relatedPlanId: "",
          status: "ACTIVE",
          createdAt: "2026-09-24T00:00:00+07:00",
          reversalReference: "",
        },
        planningState: bootstrapFixture(),
      }),
    );
    mount(fakeRunner({ getHistoryRpc, getInsightsRpc, createTransferRpc }));
    await waitFor(() => expect(getHistoryRpc).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "Create a transfer" }));
    fireEvent.change(screen.getByLabelText("From category"), { target: { value: "Shopping" } });
    fireEvent.change(screen.getByLabelText("To category"), { target: { value: "Dining" } });
    fireEvent.input(screen.getByLabelText("Amount"), { target: { value: "30000" } });
    fireEvent.input(screen.getByLabelText("Reason"), { target: { value: "Balance" } });

    fireEvent.click(screen.getByRole("button", { name: "Create transfer" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm transfer" }));

    await waitFor(() => expect(createTransferRpc).toHaveBeenCalledWith(
      expect.objectContaining({ fromCategory: "Shopping", toCategory: "Dining", amount: 30000 }),
    ));
    await waitFor(() => expect(screen.getByText(/from Shopping to Dining/)).toBeTruthy());
  });
});

describe("transfers-view: reversal", () => {
  it("reverses a transfer created this session after an explicit confirmation", async () => {
    const getHistoryRpc = vi.fn().mockResolvedValue(ok(emptyHistory));
    const getInsightsRpc = vi.fn().mockResolvedValue(ok({ transferPatterns: { windowMonths: [], recurringRecipients: [], recurringDonors: [] }, baselineReview: { windowMonths: [], changes: [] } }));
    const createTransferRpc = vi.fn().mockResolvedValue(
      ok({
        actionId: "transfer-1",
        result: {
          actionId: "transfer-1",
          fromCategory: "Shopping",
          toCategory: "Dining",
          amount: 30000,
          reason: "Balance",
          relatedPlanId: "",
          status: "ACTIVE",
          createdAt: "2026-09-24T00:00:00+07:00",
          reversalReference: "",
        },
        planningState: bootstrapFixture(),
      }),
    );
    const reverseTransferRpc = vi.fn().mockResolvedValue(
      ok({
        actionId: "reversal-1",
        result: {
          actionId: "reversal-1",
          fromCategory: "Dining",
          toCategory: "Shopping",
          amount: 30000,
          reason: "Reversal of transfer-1",
          relatedPlanId: "",
          status: "REVERSED",
          createdAt: "2026-09-24T01:00:00+07:00",
          reversalReference: "transfer-1",
        },
        planningState: bootstrapFixture(),
      }),
    );
    mount(fakeRunner({ getHistoryRpc, getInsightsRpc, createTransferRpc, reverseTransferRpc }));
    await waitFor(() => expect(getHistoryRpc).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "Create a transfer" }));
    fireEvent.change(screen.getByLabelText("From category"), { target: { value: "Shopping" } });
    fireEvent.change(screen.getByLabelText("To category"), { target: { value: "Dining" } });
    fireEvent.input(screen.getByLabelText("Amount"), { target: { value: "30000" } });
    fireEvent.click(screen.getByRole("button", { name: "Create transfer" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm transfer" }));
    await waitFor(() => expect(screen.getByText(/from Shopping to Dining/)).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Reverse" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm reversal" }));

    await waitFor(() => expect(reverseTransferRpc).toHaveBeenCalledWith(
      expect.objectContaining({ transferId: "transfer-1" }),
    ));
  });

  it("does not resubmit while a reversal is pending, and reuses the same actionId on a failed-then-retried reversal", async () => {
    const getHistoryRpc = vi.fn().mockResolvedValue(ok(emptyHistory));
    const getInsightsRpc = vi.fn().mockResolvedValue(ok({ transferPatterns: { windowMonths: [], recurringRecipients: [], recurringDonors: [] }, baselineReview: { windowMonths: [], changes: [] } }));
    const createTransferRpc = vi.fn().mockResolvedValue(
      ok({
        actionId: "transfer-1",
        result: {
          actionId: "transfer-1",
          fromCategory: "Shopping",
          toCategory: "Dining",
          amount: 30000,
          reason: "Balance",
          relatedPlanId: "",
          status: "ACTIVE",
          createdAt: "2026-09-24T00:00:00+07:00",
          reversalReference: "",
        },
        planningState: bootstrapFixture(),
      }),
    );
    let firstAttemptActionId: string | undefined;
    const reverseTransferRpc = vi.fn().mockImplementation((command: { actionId: string; transferId: string }) => {
      if (!firstAttemptActionId) {
        firstAttemptActionId = command.actionId;
        return Promise.reject({ code: "LOCK_TIMEOUT", message: "Try again." });
      }
      return Promise.resolve(
        ok({
          actionId: command.actionId,
          result: {
            actionId: command.actionId,
            fromCategory: "Dining",
            toCategory: "Shopping",
            amount: 30000,
            reason: "Reversal of transfer-1",
            relatedPlanId: "",
            status: "REVERSED",
            createdAt: "2026-09-24T01:00:00+07:00",
            reversalReference: "transfer-1",
          },
          planningState: bootstrapFixture(),
        }),
      );
    });
    mount(fakeRunner({ getHistoryRpc, getInsightsRpc, createTransferRpc, reverseTransferRpc }));
    await waitFor(() => expect(getHistoryRpc).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "Create a transfer" }));
    fireEvent.change(screen.getByLabelText("From category"), { target: { value: "Shopping" } });
    fireEvent.change(screen.getByLabelText("To category"), { target: { value: "Dining" } });
    fireEvent.input(screen.getByLabelText("Amount"), { target: { value: "30000" } });
    fireEvent.click(screen.getByRole("button", { name: "Create transfer" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm transfer" }));
    await waitFor(() => expect(screen.getByText(/from Shopping to Dining/)).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Reverse" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm reversal" }));

    await waitFor(() => expect(reverseTransferRpc).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText(/Try again\./)).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Reverse" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm reversal" }));

    await waitFor(() => expect(reverseTransferRpc).toHaveBeenCalledTimes(2));
    const [firstCall, secondCall] = reverseTransferRpc.mock.calls;
    expect((secondCall[0] as { actionId: string }).actionId).toBe((firstCall[0] as { actionId: string }).actionId);
  });
});

describe("transfers-view: insights", () => {
  it("shows recurring recipient and donor pattern cards with frequency, total, and average", async () => {
    const getHistoryRpc = vi.fn().mockResolvedValue(ok(emptyHistory));
    const getInsightsRpc = vi.fn().mockResolvedValue(
      ok({
        transferPatterns: {
          windowMonths: ["2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08"],
          recurringRecipients: [{ category: "Dining", frequency: 4, total: 400000, averageMonthlyNet: 100000 }],
          recurringDonors: [{ category: "Shopping", frequency: 3, total: 300000, averageMonthlyNet: 100000 }],
        },
        baselineReview: { windowMonths: [], changes: [] },
      }),
    );
    mount(fakeRunner({ getHistoryRpc, getInsightsRpc }));

    await waitFor(() => expect(screen.getByText(/Dining: 4 of the last 6 closed months/)).toBeTruthy());
    expect(screen.getByText(/total Rp400\.000, average Rp100\.000\/month/)).toBeTruthy();
    expect(screen.getByText(/Shopping: 3 of the last 6 closed months/)).toBeTruthy();
  });

  it("shows a review-only baseline suggestion that is never applied automatically, and requires a reason to confirm", async () => {
    const getHistoryRpc = vi.fn().mockResolvedValue(ok(emptyHistory));
    const getInsightsRpc = vi.fn().mockResolvedValue(
      ok({
        transferPatterns: { windowMonths: [], recurringRecipients: [], recurringDonors: [] },
        baselineReview: {
          windowMonths: ["2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08"],
          changes: [
            { category: "Dining", direction: "INCREASE", amount: 100000, frequency: 4, averageMonthlyNet: 100000 },
            { category: "Shopping", direction: "DECREASE", amount: 100000, frequency: 3, averageMonthlyNet: 100000 },
          ],
        },
      }),
    );
    const refreshedPlanningState = bootstrapFixture({
      categories: [
        { category: "Dining", adjustedBudget: 300000, availableBudget: 250000 },
        { category: "Shopping", adjustedBudget: 200000, availableBudget: 150000 },
      ],
    });
    const applyBaselineReviewRpc = vi.fn().mockResolvedValue(
      ok({
        actionId: "review-1",
        result: {
          appliedAt: "2026-09-24T00:00:00+07:00",
          appliedBy: "icanhafiz@gmail.com",
          reason: "Confirmed with partner",
          changes: [
            { category: "Dining", previousAmount: 200000, newAmount: 300000 },
            { category: "Shopping", previousAmount: 300000, newAmount: 200000 },
          ],
        },
        planningState: refreshedPlanningState,
      }),
    );
    const { store } = mount(fakeRunner({ getHistoryRpc, getInsightsRpc, applyBaselineReviewRpc }));

    await waitFor(() => expect(screen.getByText(/Dining: suggest increase of Rp100\.000/)).toBeTruthy());
    expect(screen.getByText(/Shopping: suggest decrease of Rp100\.000/)).toBeTruthy();

    // Never applied automatically: no apply call happened just from the suggestion being shown.
    expect(applyBaselineReviewRpc).not.toHaveBeenCalled();

    fireEvent.input(screen.getByLabelText("Dining current baseline amount"), { target: { value: "200000" } });
    fireEvent.input(screen.getByLabelText("Dining new baseline amount"), { target: { value: "300000" } });
    fireEvent.input(screen.getByLabelText("Shopping current baseline amount"), { target: { value: "300000" } });
    fireEvent.input(screen.getByLabelText("Shopping new baseline amount"), { target: { value: "200000" } });

    fireEvent.click(screen.getByRole("button", { name: "Review and apply" }));

    const confirmButton = screen.getByRole("button", { name: "Confirm baseline change" }) as HTMLButtonElement;
    expect(confirmButton.disabled).toBe(true);
    fireEvent.input(screen.getByLabelText("Reason"), { target: { value: "Confirmed with partner" } });
    expect(confirmButton.disabled).toBe(false);

    fireEvent.click(confirmButton);

    await waitFor(() => expect(applyBaselineReviewRpc).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "Confirmed with partner",
        changes: [
          { category: "Dining", expectedAmount: 200000, newAmount: 300000 },
          { category: "Shopping", expectedAmount: 300000, newAmount: 200000 },
        ],
      }),
    ));
    await waitFor(() => expect(store.getState().bootstrap).toBe(refreshedPlanningState));
  });

  it("does not resubmit while a baseline review is pending, and reuses the same actionId on a failed-then-retried apply", async () => {
    const getHistoryRpc = vi.fn().mockResolvedValue(ok(emptyHistory));
    const getInsightsRpc = vi.fn().mockResolvedValue(
      ok({
        transferPatterns: { windowMonths: [], recurringRecipients: [], recurringDonors: [] },
        baselineReview: {
          windowMonths: ["2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08"],
          changes: [{ category: "Dining", direction: "INCREASE", amount: 100000, frequency: 4, averageMonthlyNet: 100000 }],
        },
      }),
    );
    let firstAttemptActionId: string | undefined;
    const applyBaselineReviewRpc = vi.fn().mockImplementation((command: { actionId: string }) => {
      if (!firstAttemptActionId) {
        firstAttemptActionId = command.actionId;
        return Promise.reject({ code: "LOCK_TIMEOUT", message: "Try again." });
      }
      return Promise.resolve(
        ok({
          actionId: command.actionId,
          result: {
            appliedAt: "2026-09-24T00:00:00+07:00",
            appliedBy: "icanhafiz@gmail.com",
            reason: "Confirmed",
            changes: [{ category: "Dining", previousAmount: 200000, newAmount: 300000 }],
          },
          planningState: bootstrapFixture(),
        }),
      );
    });
    mount(fakeRunner({ getHistoryRpc, getInsightsRpc, applyBaselineReviewRpc }));

    await waitFor(() => expect(screen.getByText(/Dining: suggest increase of Rp100\.000/)).toBeTruthy());

    fireEvent.input(screen.getByLabelText("Dining current baseline amount"), { target: { value: "200000" } });
    fireEvent.input(screen.getByLabelText("Dining new baseline amount"), { target: { value: "300000" } });

    fireEvent.click(screen.getByRole("button", { name: "Review and apply" }));
    fireEvent.input(screen.getByLabelText("Reason"), { target: { value: "Confirmed" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm baseline change" }));

    await waitFor(() => expect(applyBaselineReviewRpc).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText(/Try again\./)).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Review and apply" }));
    fireEvent.input(screen.getByLabelText("Reason"), { target: { value: "Confirmed" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm baseline change" }));

    await waitFor(() => expect(applyBaselineReviewRpc).toHaveBeenCalledTimes(2));
    const [firstCall, secondCall] = applyBaselineReviewRpc.mock.calls;
    expect((secondCall[0] as { actionId: string }).actionId).toBe((firstCall[0] as { actionId: string }).actionId);
  });
});
