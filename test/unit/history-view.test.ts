import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/dom";
import { createApp, resetApp } from "../../src/client/client";
import { mountShell, resetViewRegistry } from "../../src/client/render";
import type { ScriptRunner } from "../../src/client/api";
import type { PlanningStateView } from "../../src/server/view-models";

function bootstrapFixture(): PlanningStateView {
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

function mount(runner: ScriptRunner) {
  const { store, api } = createApp(runner);
  mountShell(root(), store);
  store.setState({ status: "ready", view: "history", bootstrap: bootstrapFixture(), error: null });
  return { store, api };
}

beforeEach(() => {
  resetViewRegistry();
  resetApp();
});

describe("history-view", () => {
  it("shows completed, cancelled, and expired plans; reversed transfers; and received/cancelled income", async () => {
    const getHistoryRpc = vi.fn().mockResolvedValue(
      ok({
        plans: [
          {
            actionId: "plan-1", item: "Groceries", category: "Dining", paymentAccount: "Cash", amount: 100000,
            plannedDate: "2026-09-10", status: "COMPLETED", verdict: "RECOMMENDED", failedGuardrails: [],
            overrideReason: "", createdAt: "2026-09-09T00:00:00+07:00", completedAt: "2026-09-10T00:00:00+07:00",
          },
          {
            actionId: "plan-2", item: "Shoes", category: "Shopping", paymentAccount: "Cash", amount: 300000,
            plannedDate: "2026-09-11", status: "CANCELLED", verdict: "NOT_RECOMMENDED", failedGuardrails: ["CATEGORY_AVAILABILITY"],
            overrideReason: "", createdAt: "2026-09-08T00:00:00+07:00", completedAt: null,
          },
          {
            actionId: "plan-3", item: "Jacket", category: "Shopping", paymentAccount: "Cash", amount: 400000,
            plannedDate: "2026-09-01", status: "EXPIRED", verdict: "RECOMMENDED", failedGuardrails: [],
            overrideReason: "", createdAt: "2026-08-30T00:00:00+07:00", completedAt: null,
          },
        ],
        transfers: [
          {
            actionId: "transfer-1", fromCategory: "Shopping", toCategory: "Dining", amount: 50000, reason: "Cover dinner",
            relatedPlanId: "", status: "REVERSED", createdAt: "2026-09-05T00:00:00+07:00", reversalReference: "reversal-1",
          },
        ],
        income: [
          {
            actionId: "income-1", expectedDate: "2026-09-15", source: "Salary", destinationAccount: "Cash", amount: 2500000,
            note: "", status: "RECEIVED", createdAt: "2026-09-01T00:00:00+07:00",
          },
          {
            actionId: "income-2", expectedDate: "2026-09-20", source: "Bonus", destinationAccount: "Cash", amount: 500000,
            note: "", status: "CANCELLED", createdAt: "2026-09-01T00:00:00+07:00",
          },
        ],
      }),
    );
    mount(fakeRunner({ getHistoryRpc }));

    await waitFor(() => expect(getHistoryRpc).toHaveBeenCalled());

    expect(await screen.findByText(/Groceries: Rp100\.000 \(Dining, Cash\) - COMPLETED/)).toBeTruthy();
    expect(screen.getByText(/Shoes: Rp300\.000 \(Shopping, Cash\) - CANCELLED/)).toBeTruthy();
    expect(screen.getByText(/Jacket: Rp400\.000 \(Shopping, Cash\) - EXPIRED/)).toBeTruthy();

    expect(screen.getByText(/Rp50\.000 from Shopping to Dining \(Cover dinner\) - REVERSED/)).toBeTruthy();

    expect(screen.getByText(/Rp2\.500\.000 from Salary to Cash on 15 Sep 2026 - RECEIVED/)).toBeTruthy();
    expect(screen.getByText(/Rp500\.000 from Bonus to Cash on 20 Sep 2026 - CANCELLED/)).toBeTruthy();
  });

  it("shows empty-state text when there is no history yet", async () => {
    const getHistoryRpc = vi.fn().mockResolvedValue(ok({ plans: [], transfers: [], income: [] }));
    mount(fakeRunner({ getHistoryRpc }));

    expect(await screen.findByText("No completed, cancelled, or expired plans yet.")).toBeTruthy();
    expect(screen.getByText("No reversed transfers yet.")).toBeTruthy();
    expect(screen.getByText("No received or cancelled income yet.")).toBeTruthy();
  });
});
