import { describe, expect, it } from "vitest";
import {
  allowedIncomeTransitions,
  countsInForecast,
  eligibleExpectedIncome,
  parseExpectedIncomeProposal,
  transitionIncome,
  type ExpectedIncome,
  type ExpectedIncomeProposal,
  type IncomeStatus,
} from "../../src/domain/expected-income";
import { parseLocalDate, parseMoney } from "../../src/domain/validation";

function clock(overrides: { today?: string; monthEnd?: string } = {}) {
  return { today: parseLocalDate(overrides.today ?? "2026-09-23"), monthEnd: parseLocalDate(overrides.monthEnd ?? "2026-09-30") };
}

function confirmedIncome(overrides: { expectedDate: string; amount: number; status?: IncomeStatus }): Pick<ExpectedIncome, "status" | "expectedDate" | "amount"> {
  return { status: overrides.status ?? "CONFIRMED", expectedDate: parseLocalDate(overrides.expectedDate), amount: parseMoney(overrides.amount) };
}

function proposal(overrides: Partial<ExpectedIncomeProposal> = {}): ExpectedIncomeProposal {
  return {
    actionId: "income-1", expectedDate: parseLocalDate("2026-09-25"), source: "Salary",
    destinationAccount: "Main Account", amount: parseMoney(1000000), note: "",
    ...overrides,
  };
}

describe("eligibleExpectedIncome / countsInForecast", () => {
  it("excludes overdue confirmed income", () => {
    const total = eligibleExpectedIncome([
      confirmedIncome({ expectedDate: "2026-09-22", amount: 300000 }),
    ], clock({ today: "2026-09-23" }));
    expect(total).toBe(0);
  });

  it("includes confirmed income due exactly today", () => {
    expect(countsInForecast(confirmedIncome({ expectedDate: "2026-09-23", amount: 1 }), clock())).toBe(true);
  });

  it("includes confirmed income due exactly on the last day of the month", () => {
    expect(countsInForecast(confirmedIncome({ expectedDate: "2026-09-30", amount: 1 }), clock())).toBe(true);
  });

  it("excludes confirmed income due after the end of the month", () => {
    expect(countsInForecast(confirmedIncome({ expectedDate: "2026-10-01", amount: 1 }), clock())).toBe(false);
  });

  it("does not double-count received income", () => {
    expect(countsInForecast(confirmedIncome({ expectedDate: "2026-09-25", amount: 1, status: "RECEIVED" }), clock())).toBe(false);
  });

  it("excludes cancelled income", () => {
    expect(countsInForecast(confirmedIncome({ expectedDate: "2026-09-25", amount: 1, status: "CANCELLED" }), clock())).toBe(false);
  });

  it("sums every eligible entry", () => {
    const total = eligibleExpectedIncome([
      confirmedIncome({ expectedDate: "2026-09-24", amount: 200000 }),
      confirmedIncome({ expectedDate: "2026-09-30", amount: 300000 }),
      confirmedIncome({ expectedDate: "2026-09-22", amount: 999999 }),
      confirmedIncome({ expectedDate: "2026-09-25", amount: 500000, status: "RECEIVED" }),
    ], clock());
    expect(total).toBe(500000);
  });
});

describe("parseExpectedIncomeProposal", () => {
  it.each([0, -1, 1.5, "1000000", Number.MAX_SAFE_INTEGER + 1])("rejects unsafe or nonpositive amount %s", amount => {
    expect(() => parseExpectedIncomeProposal(proposal({ amount: amount as never }))).toThrow("INVALID_AMOUNT");
  });

  it.each(["2026-13-01", "2026-02-30", "not-a-date"])("rejects a malformed expected date %s", expectedDate => {
    expect(() => parseExpectedIncomeProposal(proposal({ expectedDate: expectedDate as never }))).toThrow("INVALID_DATE");
  });

  it.each([{ actionId: " " }, { source: "" }, { destinationAccount: " " }, { actionId: "=IMPORTXML(x)" }])("rejects missing or unsafe identities %j", fields => {
    expect(() => parseExpectedIncomeProposal(proposal(fields))).toThrow("INVALID_INPUT");
  });

  it("allows an optional note to be blank", () => {
    expect(parseExpectedIncomeProposal(proposal({ note: "" })).note).toBe("");
  });
});

describe("transitionIncome", () => {
  it("allows a confirmed entry to be received or cancelled", () => {
    expect(transitionIncome("CONFIRMED", "RECEIVED")).toBe("RECEIVED");
    expect(transitionIncome("CONFIRMED", "CANCELLED")).toBe("CANCELLED");
  });

  it.each(["RECEIVED", "CANCELLED"] as const)("never revives terminal %s history", status => {
    expect(() => transitionIncome(status, "CONFIRMED")).toThrow("INVALID_INPUT");
    expect(() => transitionIncome(status, "RECEIVED")).toThrow("INVALID_INPUT");
    expect(() => transitionIncome(status, "CANCELLED")).toThrow("INVALID_INPUT");
  });

  it("has exactly the documented transitions", () => {
    expect(allowedIncomeTransitions).toEqual({ CONFIRMED: ["RECEIVED", "CANCELLED"], RECEIVED: [], CANCELLED: [] });
  });
});
