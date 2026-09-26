import { describe, expect, it, vi } from "vitest";
import { createApi, createGoogleScriptRunner } from "../../src/client/api";
import type { ScriptRunner } from "../../src/client/api";
import type { RpcResult } from "../../src/server/rpc";
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
    unallocatedHeadroom: 250000,
    categories: [],
    accounts: [],
    activeReservations: [],
  };
}

/** A fake ScriptRunner whose `run` resolves/rejects however the test configures it, while
 * recording every (functionName, args) call so dispatch can be asserted without a real
 * google.script.run bridge. */
function fakeRunner<T>(result: RpcResult<T>): { runner: ScriptRunner; run: ReturnType<typeof vi.fn> } {
  const run = vi.fn().mockResolvedValue(result);
  return { runner: { run }, run };
}

describe("createApi / unwrap", () => {
  it("resolves with `data` when the runner delivers ok:true", async () => {
    const bootstrap = bootstrapFixture();
    const { runner } = fakeRunner<PlanningStateView>({ ok: true, data: bootstrap });
    const api = createApi(runner);

    await expect(api.getBootstrap()).resolves.toEqual(bootstrap);
  });

  it("rejects with the error object when the runner delivers ok:false", async () => {
    const error = { code: "INTERNAL_ERROR", message: "Something went wrong." };
    const { runner } = fakeRunner<PlanningStateView>({ ok: false, error });
    const api = createApi(runner);

    await expect(api.getBootstrap()).rejects.toEqual(error);
  });

  it("propagates an authorizationUrl on ok:false errors that carry one", async () => {
    const error = {
      code: "AUTHORIZATION_REQUIRED",
      message: "Authorization is required to continue.",
      authorizationUrl: "https://example.test/authorize",
    };
    const { runner } = fakeRunner<PlanningStateView>({ ok: false, error });
    const api = createApi(runner);

    await expect(api.getBootstrap()).rejects.toEqual(error);
  });

  it("dispatches each typed method to its documented RPC function name with the given args", async () => {
    const calls: Array<{ name: string; args: unknown[] }> = [];
    const runner: ScriptRunner = {
      run: <T>(functionName: string, ...args: unknown[]) => {
        calls.push({ name: functionName, args });
        return Promise.resolve({ ok: true, data: {} as T });
      },
    };
    const api = createApi(runner);

    const proposal = {
      actionId: "action-1",
      item: "Coffee",
      amount: 45000,
      category: "Dining",
      plannedDate: "2026-09-25",
      paymentAccount: "Cash",
    };

    await api.getBootstrap();
    await api.checkPurchase(proposal);
    await api.reservePurchase(proposal);
    await api.overridePurchase({ ...proposal, reason: "manual override" });
    await api.cancelPlan({ actionId: "action-1" });
    await api.completePlan({ actionId: "action-1" });
    await api.createTransfer({ actionId: "action-2", fromAccount: "Cash", toAccount: "BCA", amount: 10000 } as never);
    await api.reverseTransfer({ actionId: "action-2", transferId: "transfer-1" });
    await api.createExpectedIncome({ actionId: "action-3", amount: 100000, expectedDate: "2026-09-30" } as never);
    await api.updateExpectedIncome({ actionId: "action-3", status: "RECEIVED" });
    await api.getHistory();
    await api.getInsights();
    await api.applyBaselineReview({ actionId: "action-4" } as never);

    expect(calls.map(call => call.name)).toEqual([
      "getBootstrap",
      "checkPurchaseRpc",
      "reservePurchaseRpc",
      "overridePurchaseRpc",
      "cancelPlanRpc",
      "completePlanRpc",
      "createTransferRpc",
      "reverseTransferRpc",
      "createExpectedIncomeRpc",
      "updateExpectedIncomeRpc",
      "getHistoryRpc",
      "getInsightsRpc",
      "applyBaselineReviewRpc",
    ]);
    expect(calls[2]?.args).toEqual([proposal]);
    expect(calls[4]?.args).toEqual([{ actionId: "action-1" }]);
  });
});

describe("createGoogleScriptRunner", () => {
  it("rejects a run() call when google.script.run is unavailable (e.g. under jsdom)", async () => {
    const runner = createGoogleScriptRunner();

    await expect(runner.run("getBootstrap")).rejects.toThrow(/google\.script\.run is unavailable/);
  });

  it("does not throw merely from being constructed outside the Apps Script runtime", () => {
    expect(() => createGoogleScriptRunner()).not.toThrow();
  });
});
