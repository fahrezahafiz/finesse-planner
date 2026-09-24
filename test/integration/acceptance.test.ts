import { afterEach, describe, expect, it, vi } from "vitest";
import { jakartaClock } from "../../src/domain/time";
import { endpointFixture, planCommand, transferCommand, unwrap } from "../helpers/endpoint-fixture";

afterEach(() => vi.unstubAllGlobals());

/**
 * End-to-end acceptance coverage for spec section 16 ("Acceptance scenarios"), exercised entirely
 * through the secured RPC/endpoint surface (src/server/endpoints.ts) against a fake but
 * production-shaped workbook, exactly as section 14's "Verification strategy" requires: development
 * and acceptance testing happen against a workbook copy, driving user-observable behavior rather than
 * calling internal service or domain functions directly (those already have dedicated coverage from
 * Tasks 2-10). Each `it` below is numbered to match spec section 16 item-for-item.
 */

describe("Acceptance scenario 1: a within-budget dinner is recommended and reserved", () => {
  it("recommends and reserves a dinner within its adjusted category budget, funded month, savings target, and account balance", () => {
    const f = endpointFixture();
    const check = unwrap(f.endpoints.checkPurchaseRpc(planCommand({ amount: 300000 })));
    expect(check.decision.verdict).toBe("RECOMMENDED");
    expect(check.corrections).toEqual([]);

    const reservation = unwrap(f.endpoints.reservePurchaseRpc(planCommand({ amount: 300000 })));
    expect(reservation.result).toMatchObject({ status: "RESERVED", category: "Dining", amount: 300000 });

    const state = unwrap(f.endpoints.getBootstrap(undefined));
    expect(state.activeReservations).toEqual([
      { actionId: "plan-1", amount: 300000, paymentAccount: "Main Account", plannedDate: "2026-09-24" },
    ]);
  });
});

describe("Acceptance scenario 2: shoes exceeding the shopping budget show the exact shortfall", () => {
  it("does not recommend a shopping purchase over budget and shows the exact rupiah shortfall", () => {
    const f = endpointFixture();
    // Shopping's baseline budget is 400000; 450000 overruns it by exactly 50000.
    const check = unwrap(f.endpoints.checkPurchaseRpc(planCommand({ item: "Shoes", category: "Shopping", amount: 450000 })));
    expect(check.decision.verdict).toBe("NOT_RECOMMENDED");
    expect(check.decision.category).toEqual({ passed: false, shortfall: 50000 });
    expect(check.decision.firstFailure).toBe("CATEGORY_AVAILABILITY");

    const reservation = f.endpoints.reservePurchaseRpc(planCommand({ item: "Shoes", category: "Shopping", amount: 450000 }));
    expect(reservation).toMatchObject({ ok: false, error: { code: "CATEGORY_BUDGET_EXCEEDED" } });
    expect(f.planRepository.list()).toEqual([]);
  });
});

describe("Acceptance scenario 3: a valid transfer makes a purchase recommendable without reducing savings", () => {
  it("makes an otherwise-safe purchase recommendable after a month-only transfer, leaving protected savings unchanged", () => {
    const f = endpointFixture();
    const before = unwrap(f.endpoints.checkPurchaseRpc(planCommand({ item: "Shoes", category: "Shopping", amount: 450000 })));
    expect(before.decision.verdict).toBe("NOT_RECOMMENDED");
    const savingsBefore = unwrap(f.endpoints.getBootstrap(undefined)).protectedSavings;

    const transfer = unwrap(f.endpoints.createTransferRpc(transferCommand({ amount: 50000 })));
    expect(transfer.result).toMatchObject({ status: "ACTIVE", fromCategory: "Dining", toCategory: "Shopping" });

    const after = unwrap(f.endpoints.checkPurchaseRpc(planCommand({ item: "Shoes", category: "Shopping", amount: 450000 })));
    expect(after.decision.verdict).toBe("RECOMMENDED");

    const savingsAfter = unwrap(f.endpoints.getBootstrap(undefined)).protectedSavings;
    expect(savingsAfter).toBe(savingsBefore);
    expect(transfer.planningState.protectedSavings).toBe(savingsBefore);
  });
});

describe("Acceptance scenario 4: a savings breach is not recommended even with sufficient account cash", () => {
  it("blocks a purchase whose overage would breach protected savings even though the payment account has ample cash", () => {
    const f = endpointFixture({ accountBalance: 50_000_000 });
    // Dining's available budget is 600000; a 2500000 purchase overruns it by 1900000, which exceeds
    // the household's 1800000 unallocated headroom (3000000 funded - 200000 savings - 1000000 budgets)
    // and so breaches protected savings, even though the 50,000,000-balance account could easily cover it.
    const check = unwrap(f.endpoints.checkPurchaseRpc(planCommand({ amount: 2_500_000 })));
    expect(check.decision.verdict).toBe("NOT_RECOMMENDED");
    expect(check.decision.savings.passed).toBe(false);
    expect(check.decision.account.passed).toBe(true);

    const reservation = f.endpoints.reservePurchaseRpc(planCommand({ amount: 2_500_000 }));
    expect(reservation).toMatchObject({ ok: false });
    expect(f.planRepository.list()).toEqual([]);
  });
});

describe("Acceptance scenario 5: a deliberate override affects later recommendations", () => {
  it("lets an unsafe purchase be overridden with a reason, and the consumed budget affects the next check", () => {
    const f = endpointFixture();
    // 500000 exceeds Shopping's 400000 baseline budget, so a plain reservation would be rejected...
    expect(f.endpoints.reservePurchaseRpc(planCommand({ item: "Shoes", category: "Shopping", amount: 500000 })))
      .toMatchObject({ ok: false, error: { code: "CATEGORY_BUDGET_EXCEEDED" } });

    // ...but an explicit override with a reason reserves it anyway.
    const overridden = unwrap(f.endpoints.overridePurchaseRpc(planCommand({
      item: "Shoes", category: "Shopping", amount: 500000, reason: "Needed for a job interview this week",
    })));
    expect(overridden.result).toMatchObject({ status: "OVERRIDDEN", verdict: "NOT_RECOMMENDED" });

    // The override already consumed Shopping's entire budget plus 100000 more, so a later purchase
    // that would have fit against a fresh budget is now correctly rejected.
    const later = unwrap(f.endpoints.checkPurchaseRpc(planCommand({ item: "Belt", category: "Shopping", amount: 50000 })));
    expect(later.decision.verdict).toBe("NOT_RECOMMENDED");
    expect(later.decision.category).toEqual({ passed: false, shortfall: 150000 });
  });
});

describe("Acceptance scenario 6: a completed reservation appears exactly once and is no longer reserved", () => {
  it("shows a completed reservation once in Catat - Pengeluaran and removes it from active reservations", () => {
    const f = endpointFixture();
    unwrap(f.endpoints.reservePurchaseRpc(planCommand()));
    expect(unwrap(f.endpoints.getBootstrap(undefined)).activeReservations).toHaveLength(1);

    const completed = unwrap(f.endpoints.completePlanRpc({ actionId: "plan-1" }));
    expect(completed.result.status).toBe("COMPLETED");

    // A duplicate completion request (retry) must not create a second row.
    const retried = unwrap(f.endpoints.completePlanRpc({ actionId: "plan-1" }));
    expect(retried.result).toEqual(completed.result);

    const expenseRows = f.expenses.getRange("B2:F50").getValues().filter((row: unknown[]) => row[1] !== "");
    expect(expenseRows).toHaveLength(1);
    expect(expenseRows[0].slice(1)).toEqual(["Dining", "Headphones", "Main Account", 300000]);

    const state = unwrap(f.endpoints.getBootstrap(undefined));
    expect(state.activeReservations).toEqual([]);
  });
});

describe("Acceptance scenario 7: repeated transfers show a pattern and a reviewable, nonautomatic suggestion", () => {
  it("flags a recurring recipient/donor pair from history and proposes a zero-sum baseline change that is never applied automatically", () => {
    const f = endpointFixture();
    // Seed three of the six closed months (spec section 10: "at least three of the last six closed
    // months") before the current 2026-09 month with the same Dining -> Shopping net transfer.
    for (const month of ["2026-04", "2026-06", "2026-08"]) {
      f.transferRepository.append({
        actionId: `seed-${month}`, createdAt: `${month}-15T00:00:00.000+07:00`, createdBy: "first@example.test",
        month: month as never, fromCategory: "Dining", toCategory: "Shopping", amount: 100000,
        reason: "Monthly grocery top-up", relatedPlanId: "", status: "ACTIVE", reversalReference: "",
      });
    }

    const baselineBefore = f.sheets.get("Atur Budgeting")!.getRange("E2:E3").getValues();

    const insights = unwrap(f.endpoints.getInsightsRpc(undefined));
    expect(insights.transferPatterns.recurringRecipients).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: "Shopping", frequency: 3, total: 300000, averageMonthlyNet: 100000 }),
    ]));
    expect(insights.transferPatterns.recurringDonors).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: "Dining", frequency: 3, total: 300000, averageMonthlyNet: 100000 }),
    ]));
    expect(insights.baselineReview.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: "Shopping", direction: "INCREASE", amount: 100000 }),
      expect.objectContaining({ category: "Dining", direction: "DECREASE", amount: 100000 }),
    ]));

    // The suggestion is reviewable, not automatic: nothing was written until this point.
    expect(f.sheets.get("Atur Budgeting")!.getRange("E2:E3").getValues()).toEqual(baselineBefore);

    // Only an explicit, separately reviewed approval writes it.
    const applied = unwrap(f.endpoints.applyBaselineReviewRpc({
      actionId: "review-1",
      reason: "Shopping consistently receives from Dining across three closed months.",
      changes: [
        { category: "Dining", expectedAmount: 600000, newAmount: 500000 },
        { category: "Shopping", expectedAmount: 400000, newAmount: 500000 },
      ],
    }));
    expect(applied.result.changes).toEqual(expect.arrayContaining([
      { category: "Dining", previousAmount: 600000, newAmount: 500000 },
      { category: "Shopping", previousAmount: 400000, newAmount: 500000 },
    ]));
    expect(f.sheets.get("Atur Budgeting")!.getRange("E2:E3").getValues()).toEqual([[500000], [500000]]);
  });
});
