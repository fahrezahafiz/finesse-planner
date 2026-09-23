import { describe, expect, it } from "vitest";
import { appendExpenseWithKey, expenseTransactionExists, EXPENSE_TRANSACTION_METADATA_KEY } from "../../src/server/workbook/sheets-api";
import { syntheticSourceMap } from "../helpers/fake-workbook";
import { MemorySheet } from "../helpers/planning-workbook";
import { installFakeSheetsApi } from "../helpers/fake-apps-script";

function fixture() {
  const sheet = new MemorySheet("Catat - Pengeluaran", 50, 6);
  const workbook = { getId: () => "book-id", getSheetByName: (name: string) => (name === sheet.name ? sheet : null) } as any;
  const auth = { email: "member@example.test", workbook };
  const sourceMap = syntheticSourceMap();
  const controller = installFakeSheetsApi("book-id", () => new Map([[sheet.getSheetId(), sheet]]));
  return { sheet, auth, sourceMap, controller };
}

function expense(overrides: Partial<{ date: string; category: string; detail: string; account: string; amount: number }> = {}) {
  return { date: "2026-09-23", category: "Dining", detail: "Coffee with a friend", account: "Cash", amount: 45000, ...overrides };
}

describe("sheets-api using the Sheets v4 advanced service", () => {
  it("appends the row and a matching metadata entry atomically", () => {
    const f = fixture();
    expect(expenseTransactionExists(f.auth, "action-1")).toBe(false);
    appendExpenseWithKey(f.auth, f.sourceMap, expense(), "action-1");

    const row = f.sheet.getRange(2, 2, 1, 5).getValues()[0];
    expect(row).toEqual([new Date("2026-09-23T00:00:00+07:00"), "Dining", "Coffee with a friend", "Cash", 45000]);
    expect(expenseTransactionExists(f.auth, "action-1")).toBe(true);
    expect(f.controller.metadataCount()).toBe(1);
  });

  it("appends after the last existing row instead of overwriting it", () => {
    const f = fixture();
    f.sheet.getRange("B2:F2").setValues([[new Date("2026-09-20T00:00:00+07:00"), "Shopping", "Shoes", "Main Account", 100000]]);
    appendExpenseWithKey(f.auth, f.sourceMap, expense(), "action-2");
    expect(f.sheet.getRange(3, 2, 1, 5).getValues()[0]).toEqual([new Date("2026-09-23T00:00:00+07:00"), "Dining", "Coffee with a friend", "Cash", 45000]);
    expect(f.sheet.getRange(2, 2, 1, 5).getValues()[0][1]).toBe("Shopping"); // untouched
  });

  it("writes neither values nor metadata when the Sheets batch is rejected", () => {
    const f = fixture();
    f.controller.rejectNextBatchUpdate();
    expect(() => appendExpenseWithKey(f.auth, f.sourceMap, expense(), "action-3")).toThrow();
    expect(f.sheet.getRange(2, 2, 1, 5).getValues()[0]).toEqual(["", "", "", "", ""]);
    expect(f.controller.metadataCount()).toBe(0);
    expect(expenseTransactionExists(f.auth, "action-3")).toBe(false);
  });

  it("fails closed before calling Sheets when the amount is not a positive integer", () => {
    const f = fixture();
    expect(() => appendExpenseWithKey(f.auth, f.sourceMap, expense({ amount: 0 }), "action-4")).toThrow("WORKBOOK_SCHEMA_INVALID");
    expect(() => appendExpenseWithKey(f.auth, f.sourceMap, expense({ amount: 1.5 }), "action-5")).toThrow("WORKBOOK_SCHEMA_INVALID");
    expect(f.sheet.getRange(2, 2, 1, 5).getValues()[0]).toEqual(["", "", "", "", ""]);
    expect(f.controller.metadataCount()).toBe(0);
  });

  it("fails closed once the calibrated capacity is exhausted", () => {
    const f = fixture();
    const filler = Array.from({ length: 49 }, () => [new Date("2026-09-01T00:00:00+07:00"), "Dining", "x", "Cash", 1]);
    f.sheet.getRange("B2:F50").setValues(filler);
    expect(() => appendExpenseWithKey(f.auth, f.sourceMap, expense(), "action-6")).toThrow("WORKBOOK_SCHEMA_INVALID");
    expect(f.controller.metadataCount()).toBe(0);
  });

  it("uses the documented metadata key", () => {
    expect(EXPENSE_TRANSACTION_METADATA_KEY).toBe("mindfulExpenseTransaction");
  });
});
