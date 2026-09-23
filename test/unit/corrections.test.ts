import { describe, expect, it } from "vitest";
import { suggestCorrections } from "../../src/domain/corrections";
import { evaluatePurchase } from "../../src/domain/recommendation";
import type { PlanningSnapshot, Proposal } from "../../src/domain/types";
import { parseLocalDate, parseMoney, parseYearMonth } from "../../src/domain/validation";

function proposal(overrides: Partial<Proposal> = {}): Proposal {
  return { actionId: "proposal-1", item: "Headphones", amount: parseMoney(500000), category: "Shopping", plannedDate: parseLocalDate("2026-09-24"), paymentAccount: "Main", ...overrides };
}

function snapshot(overrides: Record<string, unknown> = {}): PlanningSnapshot {
  return {
    month: parseYearMonth("2026-09"), health: "HEALTHY", actualIncome: parseMoney(1000000), confirmedFutureIncome: parseMoney(0), protectedSavingsTarget: parseMoney(200000), totalAdjustedBudgets: parseMoney(800000), unallocatedHeadroom: 0,
    categories: {
      Shopping: { baselineBudget: parseMoney(400000), transfersIn: parseMoney(0), transfersOut: parseMoney(0), adjustedBudget: parseMoney(400000), actualSpending: parseMoney(0), activeReservations: parseMoney(0), availableBudget: 400000 },
      Dining: { baselineBudget: parseMoney(100000), transfersIn: parseMoney(0), transfersOut: parseMoney(0), adjustedBudget: parseMoney(100000), actualSpending: parseMoney(0), activeReservations: parseMoney(0), availableBudget: 100000 },
    },
    accounts: { Main: { currentBalance: parseMoney(1000000) }, Wallet: { currentBalance: parseMoney(1000000) } },
    planningDate: parseLocalDate("2026-09-23"), daysRemainingInclusive: 8, confirmedIncome: [], activeReservations: [], ...overrides,
  } as PlanningSnapshot;
}

describe("suggestCorrections", () => {
  it("offers the lower price first at the smallest passed guardrail amount", () => {
    const state = snapshot(); const result = suggestCorrections(state, proposal(), evaluatePurchase(state, proposal()));
    expect(result[0]).toEqual({ kind: "LOWER_PRICE", amount: 400000 });
  });

  it("uses account-safe amount when it is one rupiah below category availability", () => {
    const state = snapshot({ accounts: { Main: { currentBalance: parseMoney(399999) }, Wallet: { currentBalance: parseMoney(0) } } });
    const result = suggestCorrections(state, proposal(), evaluatePurchase(state, proposal()));
    expect(result[0]).toEqual({ kind: "LOWER_PRICE", amount: 399999 });
  });

  it("offers an exact zero-sum donor transfer after lower price", () => {
    const state = snapshot(); const result = suggestCorrections(state, proposal(), evaluatePurchase(state, proposal()));
    expect(result[1]).toEqual({ kind: "TRANSFER", fromCategory: "Dining", toCategory: "Shopping", amount: 100000 });
  });

  it("never proposes savings as a transfer donor", () => {
    const state = snapshot({ categories: { Shopping: (snapshot().categories.Shopping) } });
    const result = suggestCorrections(state, proposal(), evaluatePurchase(state, proposal()));
    expect(result.some(correction => correction.kind === "TRANSFER" && correction.fromCategory === "Savings")).toBe(false);
  });

  it("offers a sufficient alternate account after transfer", () => {
    const state = snapshot({
      categories: { ...snapshot().categories, Shopping: { ...snapshot().categories.Shopping, availableBudget: 500000 } },
      accounts: { Main: { currentBalance: parseMoney(0) }, Wallet: { currentBalance: parseMoney(500000) } },
    });
    const result = suggestCorrections(state, proposal(), evaluatePurchase(state, proposal()));
    expect(result.map(correction => correction.kind)).toEqual(["ALTERNATE_ACCOUNT"]);
    expect(result[0]).toEqual({ kind: "ALTERNATE_ACCOUNT", paymentAccount: "Wallet" });
  });

  it("offers the earliest income date that makes the selected account pass last", () => {
    const state = snapshot({
      categories: { ...snapshot().categories, Shopping: { ...snapshot().categories.Shopping, availableBudget: 500000 } },
      accounts: { Main: { currentBalance: parseMoney(0) }, Wallet: { currentBalance: parseMoney(0) } },
      confirmedIncome: [
        { amount: parseMoney(500000), destinationAccount: "Main", expectedDate: parseLocalDate("2026-09-26") },
        { amount: parseMoney(500000), destinationAccount: "Main", expectedDate: parseLocalDate("2026-09-25") },
      ],
    });
    const result = suggestCorrections(state, proposal(), evaluatePurchase(state, proposal()));
    expect(result.at(-1)).toEqual({ kind: "WAIT_FOR_INCOME", expectedDate: "2026-09-25" });
  });

  it("returns no correction when invalid health is the unresolved first failure", () => {
    const state = snapshot({ health: "FORMULA_ERROR", actualIncome: NaN }); const decision = evaluatePurchase(state, proposal());
    expect(suggestCorrections(state, proposal(), decision)).toEqual([]);
  });

  it("returns no correction when no single change fixes category and account failures", () => {
    const state = snapshot({ accounts: { Main: { currentBalance: parseMoney(0) }, Wallet: { currentBalance: parseMoney(0) } } });
    const decision = evaluatePurchase(state, proposal());
    expect(suggestCorrections(state, proposal(), decision)).toEqual([]);
  });
});
