import { describe, expect, it } from "vitest";
import { evaluatePurchase } from "../../src/domain/recommendation";
import type { PlanningHealth, PlanningSnapshot, Proposal } from "../../src/domain/types";
import { parseLocalDate, parseMoney, parseYearMonth } from "../../src/domain/validation";

function proposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    actionId: "proposal-1", item: "Headphones", amount: parseMoney(500000), category: "Shopping",
    plannedDate: parseLocalDate("2026-09-24"), paymentAccount: "Main",
    ...overrides,
  };
}

function healthySnapshot(overrides: Record<string, unknown> = {}): PlanningSnapshot {
  return {
    month: parseYearMonth("2026-09"), health: "HEALTHY", actualIncome: parseMoney(1000000), confirmedFutureIncome: parseMoney(0),
    protectedSavingsTarget: parseMoney(200000), totalAdjustedBudgets: parseMoney(800000), unallocatedHeadroom: 0,
    categories: { Shopping: { baselineBudget: parseMoney(500000), transfersIn: parseMoney(0), transfersOut: parseMoney(0), adjustedBudget: parseMoney(500000), actualSpending: parseMoney(0), activeReservations: parseMoney(0), availableBudget: 500000 } },
    accounts: { Main: { currentBalance: parseMoney(1000000) } },
    planningDate: parseLocalDate("2026-09-23"), daysRemainingInclusive: 8,
    confirmedIncome: [], activeReservations: [],
    ...overrides,
  } as PlanningSnapshot;
}

function invalidSnapshot(health: Exclude<PlanningHealth, "HEALTHY">): PlanningSnapshot {
  return healthySnapshot({ health, actualIncome: NaN, confirmedFutureIncome: NaN, protectedSavingsTarget: NaN, totalAdjustedBudgets: NaN, unallocatedHeadroom: NaN });
}

describe("evaluatePurchase", () => {
  it("recommends a purchase exactly equal to category availability", () => {
    const decision = evaluatePurchase(healthySnapshot({ categoryAvailable: 500000 }), proposal({ amount: parseMoney(500000) }));
    expect(decision.verdict).toBe("RECOMMENDED");
  });

  it("rejects one rupiah above category availability", () => {
    const decision = evaluatePurchase(healthySnapshot(), proposal({ amount: parseMoney(500001) }));
    expect(decision.verdict).toBe("NOT_RECOMMENDED");
    expect(decision.category.shortfall).toBe(1);
  });

  it("reports an already-overdrawn category as a recommendation failure, not an unavailable workbook", () => {
    const snapshot = healthySnapshot({ categories: { Shopping: { ...healthySnapshot().categories.Shopping, availableBudget: -1 } } });
    const decision = evaluatePurchase(snapshot, proposal({ amount: parseMoney(1) }));
    expect(decision.verdict).toBe("NOT_RECOMMENDED");
    expect(decision.category.shortfall).toBe(2);
  });

  it("returns unable when workbook health is invalid", () => {
    const decision = evaluatePurchase(invalidSnapshot("FORMULA_ERROR"), proposal());
    expect(decision.verdict).toBe("UNABLE_TO_EVALUATE");
    expect(decision.failedGuardrails).toEqual(["SCHEMA_AND_FORMULA_HEALTH"]);
  });

  it("keeps savings safe exactly at the protected target", () => {
    const decision = evaluatePurchase(healthySnapshot(), proposal({ amount: parseMoney(500000) }));
    expect(decision.savings).toEqual({ passed: true, shortfall: 0 });
  });

  it("rejects a one-rupiah savings breach", () => {
    const snapshot = healthySnapshot({ actualIncome: parseMoney(999999), totalAdjustedBudgets: parseMoney(800000) });
    const decision = evaluatePurchase(snapshot, proposal({ amount: parseMoney(500000) }));
    expect(decision.savings).toEqual({ passed: false, shortfall: 1 });
  });

  it("includes overruns in every category when protecting savings", () => {
    const base = healthySnapshot();
    const snapshot = healthySnapshot({
      actualIncome: parseMoney(1200000),
      totalAdjustedBudgets: parseMoney(1000000),
      protectedSavingsTarget: parseMoney(200000),
      categories: {
        Dining: { ...base.categories.Shopping, adjustedBudget: parseMoney(600000), activeReservations: parseMoney(700000), availableBudget: -100000 },
        Shopping: { ...base.categories.Shopping, adjustedBudget: parseMoney(400000), availableBudget: 400000 },
      },
    });

    const decision = evaluatePurchase(snapshot, proposal({ amount: parseMoney(100000) }));

    expect(decision.savings).toEqual({ passed: false, shortfall: 100000 });
  });

  it("protects both earlier and later active reservations in the account schedule", () => {
    const snapshot = healthySnapshot({
      accounts: { Main: { currentBalance: parseMoney(700000) } },
      activeReservations: [
        { actionId: "r1", amount: parseMoney(200000), paymentAccount: "Main", plannedDate: parseLocalDate("2026-09-24") },
        { actionId: "r2", amount: parseMoney(200000), paymentAccount: "Main", plannedDate: parseLocalDate("2026-09-25") },
      ],
    });
    const decision = evaluatePurchase(snapshot, proposal({ amount: parseMoney(500001) }));
    expect(decision.account).toEqual({ passed: false, shortfall: 200001 });
  });

  it("does not count confirmed income after the planned date", () => {
    const snapshot = healthySnapshot({
      accounts: { Main: { currentBalance: parseMoney(499999) } },
      confirmedIncome: [{ amount: parseMoney(1), destinationAccount: "Main", expectedDate: parseLocalDate("2026-09-25") }],
    });
    const decision = evaluatePurchase(snapshot, proposal({ amount: parseMoney(500000) }));
    expect(decision.account.shortfall).toBe(1);
  });

  it("accepts confirmed income into the selected account on the planned date", () => {
    const snapshot = healthySnapshot({
      accounts: { Main: { currentBalance: parseMoney(499999) } },
      confirmedIncome: [{ amount: parseMoney(1), destinationAccount: "Main", expectedDate: parseLocalDate("2026-09-24") }],
    });
    expect(evaluatePurchase(snapshot, proposal({ amount: parseMoney(500000) })).account.passed).toBe(true);
  });

  it("does not let an earlier purchase consume cash reserved for a later purchase", () => {
    const snapshot = healthySnapshot({
      accounts: { Main: { currentBalance: parseMoney(300000) } },
      activeReservations: [
        { actionId: "later", amount: parseMoney(300000), paymentAccount: "Main", plannedDate: parseLocalDate("2026-09-30") },
      ],
    });

    const decision = evaluatePurchase(snapshot, proposal({ amount: parseMoney(300000) }));

    expect(decision.account).toEqual({ passed: false, shortfall: 300000 });
  });

  it("allows later confirmed income to fund a later reservation", () => {
    const snapshot = healthySnapshot({
      accounts: { Main: { currentBalance: parseMoney(300000) } },
      confirmedIncome: [{ amount: parseMoney(300000), destinationAccount: "Main", expectedDate: parseLocalDate("2026-09-28") }],
      activeReservations: [
        { actionId: "later", amount: parseMoney(300000), paymentAccount: "Main", plannedDate: parseLocalDate("2026-09-30") },
      ],
    });

    expect(evaluatePurchase(snapshot, proposal({ amount: parseMoney(300000) })).account.passed).toBe(true);
  });

  it("keeps underfunded planning months non-recommendable before later failures", () => {
    const decision = evaluatePurchase(invalidSnapshot("UNDERFUNDED"), proposal({ amount: parseMoney(500001) }));
    expect(decision.firstFailure).toBe("PLANNING_MONTH_HEALTH");
    expect(decision.verdict).toBe("UNABLE_TO_EVALUATE");
  });

  it("uses the inclusive remaining days and clamps the safe daily allowance at zero", () => {
    const snapshot = healthySnapshot({ daysRemainingInclusive: 0 });
    expect(evaluatePurchase(snapshot, proposal()).safeDailyAllowance).toBe(0);
  });

  it("divides the post-purchase category availability by inclusive days remaining", () => {
    const decision = evaluatePurchase(healthySnapshot({ daysRemainingInclusive: 8 }), proposal({ amount: parseMoney(100000) }));
    expect(decision.safeDailyAllowance).toBe(50000);
  });

  it("does not merge literal category identities that differ only by case", () => {
    const decision = evaluatePurchase(healthySnapshot(), proposal({ category: "shopping", amount: parseMoney(1) }));
    expect(decision.category).toEqual({ passed: false, shortfall: 1 });
  });

  it("records every failed guardrail while retaining the ordered first failure", () => {
    const snapshot = healthySnapshot({ accounts: { Main: { currentBalance: parseMoney(0) } }, actualIncome: parseMoney(999999) });
    const decision = evaluatePurchase(snapshot, proposal({ amount: parseMoney(500001) }));
    expect(decision.failedGuardrails).toEqual(["CATEGORY_AVAILABILITY", "PROTECTED_SAVINGS", "ACCOUNT_LIQUIDITY"]);
    expect(decision.firstFailure).toBe("CATEGORY_AVAILABILITY");
  });

  it("uses exact account arithmetic for a one-rupiah deficit beyond Number's safe aggregate range", () => {
    const snapshot = healthySnapshot({
      categories: { Shopping: { ...healthySnapshot().categories.Shopping, availableBudget: Number.MAX_SAFE_INTEGER } },
      accounts: { Main: { currentBalance: parseMoney(Number.MAX_SAFE_INTEGER) } },
      confirmedIncome: [{ amount: parseMoney(4), destinationAccount: "Main", expectedDate: parseLocalDate("2026-09-24") }],
      activeReservations: [{ actionId: "r1", amount: parseMoney(Number.MAX_SAFE_INTEGER), paymentAccount: "Main", plannedDate: parseLocalDate("2026-09-24") }],
    });
    const decision = evaluatePurchase(snapshot, proposal({ amount: parseMoney(5) }));
    expect(decision.verdict).toBe("NOT_RECOMMENDED");
    expect(decision.account).toEqual({ passed: false, shortfall: 1 });
  });

  it.each([NaN, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])("returns unable for malformed proposal amount %s", amount => {
    const decision = evaluatePurchase(healthySnapshot(), proposal({ amount: amount as never }));
    expect(decision.verdict).toBe("UNABLE_TO_EVALUATE");
    expect(decision.safeDailyAllowance).toBe(0);
  });
});
