import { describe, expect, it } from "vitest";
import {
  analyzeTransferPatterns,
  parseApprovedBaselineChange,
  proposeBaselineReview,
} from "../../src/domain/insights";
import { PROTECTED_SAVINGS_CATEGORY, type Transfer, type TransferStatus } from "../../src/domain/transfers";
import { parseMoney, parseYearMonth } from "../../src/domain/validation";

let counter = 0;
function transfer(
  month: string,
  fromCategory: string,
  toCategory: string,
  amount: number,
  status: TransferStatus = "ACTIVE",
  reversalReference = "",
): Transfer {
  counter += 1;
  return {
    actionId: `transfer-${counter}`,
    fromCategory,
    toCategory,
    amount: parseMoney(amount),
    reason: "test transfer",
    relatedPlanId: "",
    createdAt: `${month}-15T00:00:00+07:00`,
    createdBy: "tester@example.test",
    month: parseYearMonth(month),
    status,
    reversalReference,
  };
}

function historyForMonths(byMonth: Record<string, Record<string, number>>, fromCategory = "Dining"): Transfer[] {
  return Object.entries(byMonth).flatMap(([month, categories]) =>
    Object.entries(categories).map(([category, amount]) => transfer(month, fromCategory, category, amount)),
  );
}

describe("analyzeTransferPatterns", () => {
  it("flags a recipient in three of six closed months", () => {
    const result = analyzeTransferPatterns(historyForMonths({
      "2026-03": { Shopping: 100000 },
      "2026-05": { Shopping: 200000 },
      "2026-08": { Shopping: 300000 },
    }), parseYearMonth("2026-09"));

    expect(result.recurringRecipients[0]).toMatchObject({
      category: "Shopping",
      frequency: 3,
      total: 600000,
      averageMonthlyNet: 200000,
    });
  });

  it("computes the six-month closed window immediately before the current month", () => {
    const result = analyzeTransferPatterns([], parseYearMonth("2026-09"));
    expect(result.windowMonths).toEqual(["2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08"]);
  });

  it("flags a category recurring in exactly two of six closed months", () => {
    const result = analyzeTransferPatterns(historyForMonths({
      "2026-04": { Shopping: 50000 },
      "2026-07": { Shopping: 150000 },
    }), parseYearMonth("2026-09"));

    expect(result.recurringRecipients[0]).toMatchObject({ category: "Shopping", frequency: 2, total: 200000, averageMonthlyNet: 100000 });
  });

  it("excludes the current open month from the closed-month totals", () => {
    const result = analyzeTransferPatterns(historyForMonths({
      "2026-04": { Shopping: 100000 },
      "2026-07": { Shopping: 150000 },
      "2026-09": { Shopping: 999999999 },
    }), parseYearMonth("2026-09"));

    expect(result.windowMonths).not.toContain("2026-09");
    expect(result.recurringRecipients[0]).toMatchObject({ category: "Shopping", frequency: 2, total: 250000 });
  });

  it("does not flag a category that occurs only once in the window", () => {
    const result = analyzeTransferPatterns(historyForMonths({ "2026-06": { Shopping: 100000 } }), parseYearMonth("2026-09"));
    expect(result.recurringRecipients).toEqual([]);
  });

  it("excludes a reversed transfer's month from recurrence totals", () => {
    // The original row flips to REVERSED and the reversing row is created already REVERSED (Task 8's
    // design), so neither carries a lasting effect; both must contribute zero to historical totals.
    const original = transfer("2026-04", "Dining", "Shopping", 500000, "REVERSED");
    const reversingEntry = { ...transfer("2026-04", "Shopping", "Dining", 500000, "REVERSED"), reversalReference: original.actionId };
    const history = [
      original,
      reversingEntry,
      transfer("2026-06", "Dining", "Shopping", 100000),
      transfer("2026-08", "Dining", "Shopping", 200000),
    ];
    const result = analyzeTransferPatterns(history, parseYearMonth("2026-09"));
    const shopping = result.recurringRecipients.find(r => r.category === "Shopping");
    expect(shopping).toMatchObject({ frequency: 2, total: 300000, averageMonthlyNet: 150000 });
  });

  it("excludes a lone REVERSED-status row with no reversing counterpart from recurrence totals", () => {
    // The test above pairs a REVERSED original with its REVERSED reversing row. reversingTransfer
    // always keeps the same month and amount and swaps categories, so that pair nets to zero by
    // arithmetic symmetry alone -- it would pass even if the ACTIVE-only filter were never applied.
    // This test removes that symmetry: a REVERSED original with NO counterpart row at all (the
    // interrupted-write state from transfer-service.ts, where the reversing row can be persisted before
    // the original's status flip completes, or simply a status flip with the counterpart row missing
    // from this history slice). Only the `status === "ACTIVE"` filter -- not any arithmetic cancellation
    // -- can zero this row out, so this proves the filter is doing real work.
    const history = [
      transfer("2026-04", "Dining", "Shopping", 500000, "REVERSED"),
      transfer("2026-06", "Dining", "Shopping", 100000),
      transfer("2026-08", "Dining", "Shopping", 200000),
    ];
    const result = analyzeTransferPatterns(history, parseYearMonth("2026-09"));
    const shopping = result.recurringRecipients.find(r => r.category === "Shopping");
    // Only the two ACTIVE months count; the lone REVERSED 2026-04 row contributes zero and does not
    // count toward frequency. A buggy implementation that ignored status would instead see frequency 3.
    expect(shopping).toMatchObject({ frequency: 2, total: 300000, averageMonthlyNet: 150000 });
  });

  it("flags a recurring donor symmetrically with recurring recipients", () => {
    const result = analyzeTransferPatterns(historyForMonths({
      "2026-03": { Shopping: 100000 },
      "2026-05": { Shopping: 200000 },
      "2026-08": { Shopping: 300000 },
    }), parseYearMonth("2026-09"));

    expect(result.recurringDonors[0]).toMatchObject({ category: "Dining", frequency: 3, total: 600000, averageMonthlyNet: 200000 });
  });

  it("rounds the monthly average to the nearest whole IDR", () => {
    const result = analyzeTransferPatterns(historyForMonths({
      "2026-03": { Shopping: 100000 },
      "2026-05": { Shopping: 150000 },
      "2026-08": { Shopping: 130000 },
    }), parseYearMonth("2026-09"));

    const shopping = result.recurringRecipients.find(r => r.category === "Shopping");
    expect(shopping).toMatchObject({ total: 380000, averageMonthlyNet: 126667 });
  });

  it("never flags the protected savings category even if it appears in transfer history", () => {
    const history = [
      transfer("2026-04", "Dining", PROTECTED_SAVINGS_CATEGORY, 100000),
      transfer("2026-06", "Dining", PROTECTED_SAVINGS_CATEGORY, 100000),
    ];
    const result = analyzeTransferPatterns(history, parseYearMonth("2026-09"));
    expect(result.recurringRecipients.some(r => r.category === PROTECTED_SAVINGS_CATEGORY)).toBe(false);
  });
});

describe("proposeBaselineReview", () => {
  it("proposes no changes when there is insufficient recurring donor evidence", () => {
    const history = [
      transfer("2026-04", "Groceries1", "Shopping", 100000),
      transfer("2026-06", "Entertainment1", "Shopping", 150000),
      transfer("2026-08", "Groceries2", "Shopping", 130000),
    ];
    const result = proposeBaselineReview(history, parseYearMonth("2026-09"));
    expect(result.changes).toEqual([]);
  });

  it("never suggests a donor reduction larger than its own recurring evidence", () => {
    // Shopping's recipient evidence (avg 500000) far exceeds Dining's donor evidence (avg 50000).
    const history = [
      transfer("2026-03", "Freelance", "Shopping", 400000),
      transfer("2026-05", "Bonus", "Shopping", 600000),
      transfer("2026-07", "Dining", "Misc1", 50000),
      transfer("2026-08", "Dining", "Misc2", 50000),
    ];
    const result = proposeBaselineReview(history, parseYearMonth("2026-09"));
    const donorChange = result.changes.find(c => c.category === "Dining");
    expect(donorChange).toMatchObject({ direction: "DECREASE", amount: 50000 });
    const totalIncrease = result.changes.filter(c => c.direction === "INCREASE").reduce((sum, c) => sum + c.amount, 0);
    expect(totalIncrease).toBe(50000);
  });

  it("pairs recipient increases with donor reductions that sum to exactly zero", () => {
    const history = [
      transfer("2026-03", "Groceries1", "Shopping", 40000),
      transfer("2026-05", "Groceries2", "Shopping", 60000),
      transfer("2026-04", "Leisure1", "Entertainment", 30000),
      transfer("2026-06", "Leisure2", "Entertainment", 50000),
      transfer("2026-07", "Dining", "MiscA", 100000),
      transfer("2026-08", "Dining", "MiscB", 100000),
    ];
    const result = proposeBaselineReview(history, parseYearMonth("2026-09"));

    const net = result.changes.reduce((sum, c) => sum + (c.direction === "INCREASE" ? c.amount : -c.amount), 0);
    expect(net).toBe(0);
    expect(result.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: "Shopping", direction: "INCREASE", amount: 50000 }),
      expect.objectContaining({ category: "Entertainment", direction: "INCREASE", amount: 40000 }),
      expect.objectContaining({ category: "Dining", direction: "DECREASE", amount: 90000 }),
    ]));
    expect(result.changes).toHaveLength(3);
  });

  it("excludes a category that is a recurring recipient in some months and a recurring donor in others", () => {
    // Shopping funds Entertainment twice, and separately receives funding from Dining twice: its
    // evidence is inconsistent, so it must not appear as either an increase or a decrease suggestion.
    const history = [
      transfer("2026-03", "Shopping", "Entertainment", 50000),
      transfer("2026-05", "Shopping", "Entertainment", 50000),
      transfer("2026-06", "Dining", "Shopping", 60000),
      transfer("2026-08", "Dining", "Shopping", 60000),
    ];
    const result = proposeBaselineReview(history, parseYearMonth("2026-09"));
    expect(result.changes.some(c => c.category === "Shopping")).toBe(false);
  });

  it("never proposes the protected savings category as a donor or recipient", () => {
    const history = [
      transfer("2026-04", "Dining", PROTECTED_SAVINGS_CATEGORY, 100000),
      transfer("2026-06", "Dining", PROTECTED_SAVINGS_CATEGORY, 100000),
      transfer("2026-07", "Dining", "Shopping", 100000),
      transfer("2026-08", "Dining", "Shopping", 100000),
    ];
    const result = proposeBaselineReview(history, parseYearMonth("2026-09"));
    expect(result.changes.some(c => c.category === PROTECTED_SAVINGS_CATEGORY)).toBe(false);
  });
});

describe("parseApprovedBaselineChange", () => {
  function command(overrides: Record<string, unknown> = {}) {
    return {
      actionId: "review-1",
      reason: "Shopping consistently overspends; Dining consistently has headroom.",
      changes: [
        { category: "Dining", expectedAmount: 600000, newAmount: 500000 },
        { category: "Shopping", expectedAmount: 400000, newAmount: 500000 },
      ],
      ...overrides,
    };
  }

  it("parses a valid, zero-sum reviewed change set", () => {
    const parsed = parseApprovedBaselineChange(command());
    expect(parsed.actionId).toBe("review-1");
    expect(parsed.changes).toHaveLength(2);
  });

  it("rejects a change set that does not sum to zero", () => {
    expect(() => parseApprovedBaselineChange(command({
      changes: [
        { category: "Dining", expectedAmount: 600000, newAmount: 500000 },
        { category: "Shopping", expectedAmount: 400000, newAmount: 600000 },
      ],
    }))).toThrow("INVALID_INPUT");
  });

  it("rejects a no-op change set", () => {
    expect(() => parseApprovedBaselineChange(command({
      changes: [
        { category: "Dining", expectedAmount: 600000, newAmount: 600000 },
        { category: "Shopping", expectedAmount: 400000, newAmount: 400000 },
      ],
    }))).toThrow("INVALID_INPUT");
  });

  it("rejects the protected savings category as a change target", () => {
    expect(() => parseApprovedBaselineChange(command({
      changes: [
        { category: PROTECTED_SAVINGS_CATEGORY, expectedAmount: 200000, newAmount: 100000 },
        { category: "Shopping", expectedAmount: 400000, newAmount: 500000 },
      ],
    }))).toThrow("INVALID_INPUT");
  });

  it("rejects a duplicate category within one change set", () => {
    expect(() => parseApprovedBaselineChange(command({
      changes: [
        { category: "Dining", expectedAmount: 600000, newAmount: 500000 },
        { category: "Dining", expectedAmount: 600000, newAmount: 700000 },
      ],
    }))).toThrow("INVALID_INPUT");
  });

  it("rejects fewer than two changes", () => {
    expect(() => parseApprovedBaselineChange(command({ changes: [{ category: "Dining", expectedAmount: 600000, newAmount: 600000 }] })))
      .toThrow("INVALID_INPUT");
  });

  it("rejects a missing reason", () => {
    expect(() => parseApprovedBaselineChange(command({ reason: "" }))).toThrow("INVALID_INPUT");
  });
});
