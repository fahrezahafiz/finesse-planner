import { describe, expect, it } from "vitest";
import { toPlanningStateView } from "../../src/server/view-models";
import type { PlanningHealth, PlanningSnapshot } from "../../src/domain/types";
import { parseLocalDate, parseMoney, parseYearMonth } from "../../src/domain/validation";

function healthySnapshot(overrides: Partial<PlanningSnapshot> = {}): PlanningSnapshot {
  return {
    month: parseYearMonth("2026-09"), health: "HEALTHY", actualIncome: parseMoney(1000000), confirmedFutureIncome: parseMoney(0),
    protectedSavingsTarget: parseMoney(200000), totalAdjustedBudgets: parseMoney(800000), unallocatedHeadroom: 0,
    categories: {}, accounts: {},
    planningDate: parseLocalDate("2026-09-23"), daysRemainingInclusive: 8,
    confirmedIncome: [], activeReservations: [],
    ...overrides,
  } as PlanningSnapshot;
}

function invalidSnapshot(health: Exclude<PlanningHealth, "HEALTHY" | "UNDERFUNDED">): PlanningSnapshot {
  return healthySnapshot({ health, actualIncome: NaN as never, confirmedFutureIncome: NaN as never, protectedSavingsTarget: NaN as never, totalAdjustedBudgets: NaN as never, unallocatedHeadroom: NaN });
}

describe("toPlanningStateView", () => {
  it("throws UNSAFE_MONEY_RESULT instead of silently losing precision when funded amount overflows a healthy snapshot", () => {
    const snapshot = healthySnapshot({ actualIncome: Number.MAX_SAFE_INTEGER as never, confirmedFutureIncome: 1 as never });
    expect(() => toPlanningStateView(snapshot)).toThrow("UNSAFE_MONEY_RESULT");
  });

  it("still allows an underfunded (not invalid) snapshot's funded amount through unguarded-overflow checks", () => {
    const snapshot = healthySnapshot({ health: "UNDERFUNDED", actualIncome: parseMoney(500000), confirmedFutureIncome: parseMoney(0) });
    expect(toPlanningStateView(snapshot).fundedAmount).toBe(500000);
  });

  it("does not throw for an invalid-health snapshot's documented NaN funded amount (consumers gate on health, not on this arithmetic)", () => {
    const snapshot = invalidSnapshot("FORMULA_ERROR");
    const view = toPlanningStateView(snapshot);
    expect(view.health).toBe("FORMULA_ERROR");
    expect(Number.isNaN(view.fundedAmount)).toBe(true);
  });
});
