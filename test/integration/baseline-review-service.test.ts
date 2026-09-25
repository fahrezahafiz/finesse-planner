import { describe, expect, it } from "vitest";
import { applyApprovedBaselineChange } from "../../src/server/services/baseline-review-service";
import { setupPlanningSheets } from "../../src/server/workbook/setup";
import { jakartaClock } from "../../src/domain/time";
import { planningWorkbook } from "../helpers/planning-workbook";

function fixture() {
  const f = planningWorkbook();
  setupPlanningSheets(f.auth, f.map);
  const budgeting = f.sheets.get("Atur Budgeting")!;
  // Unambiguous 1:1 category-to-row baseline, overriding the default fixture's duplicate "Dining" rows.
  budgeting.getRange("D2:E3").setValues([["Dining", 600000], ["Shopping", 400000]]);
  f.sheets.get("Catat - Pendapatan")!.getRange("F2").setValue(3000000);
  f.sheets.get("backend")!.getRange("C2").setValue(3000000);
  f.sheets.get("Ringkasan Perencanaan")!.getRange("A2:H3").setValues([
    ["Dining", 600000, 0, 0, 600000, 0, 0, 600000],
    ["Shopping", 400000, 0, 0, 400000, 0, 0, 400000],
  ]);
  f.sheets.get("Ringkasan Perencanaan")!.getRange("K1:K12").setValues([
    [3000000], [0], [3000000], [200000], [1000000], [1000000], [1800000], [1800000], ["HEALTHY"], [0], ["2026-09"], ["2026-09-23"],
  ]);
  let held = false;
  let onAcquire = () => {};
  const lock = { tryLock: (_ms: number) => { if (held) return false; held = true; onAcquire(); return true; }, releaseLock: () => { held = false; } };
  const flush = () => {
    const sourceRows = budgeting.getRange("D2:E50").getValues().filter(row => row[0] !== "");
    const dining = sourceRows.filter(row => row[0] === "Dining").reduce((sum, row) => sum + Number(row[1]), 0);
    const shopping = sourceRows.filter(row => row[0] === "Shopping").reduce((sum, row) => sum + Number(row[1]), 0);
    const total = dining + shopping;
    f.sheets.get("Ringkasan Perencanaan")!.getRange("B2:E3").setValues([
      [dining, 0, 0, dining],
      [shopping, 0, 0, shopping],
    ]);
    f.sheets.get("Ringkasan Perencanaan")!.getRange("H2:H3").setValues([[dining], [shopping]]);
    const headroom = 3000000 - 200000 - total;
    f.sheets.get("Ringkasan Perencanaan")!.getRange("K5:K9").setValues([[total], [total], [headroom], [headroom], [headroom >= 0 ? "HEALTHY" : "INVALID"]]);
  };
  const deps = {
    auth: f.auth,
    clock: jakartaClock(new Date("2026-09-23T00:00:00Z")),
    sourceMap: f.map,
    lock,
    flush,
  };
  return { ...f, budgeting, deps, held: () => held, onAcquire: (fn: () => void) => { onAcquire = fn; } };
}

function reviewCommand(overrides: Record<string, unknown> = {}) {
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

describe("applyApprovedBaselineChange", () => {
  it("writes a reviewed zero-sum change to the exact calibrated baseline cells", () => {
    const f = fixture();
    const result = applyApprovedBaselineChange(reviewCommand(), f.deps);
    expect(f.budgeting.getRange("E2:E3").getValues()).toEqual([[500000], [500000]]);
    expect(result.actionId).toBe("review-1");
    expect(result.appliedBy).toBe("first@example.test");
    expect(result.changes).toEqual(expect.arrayContaining([
      { category: "Dining", previousAmount: 600000, newAmount: 500000 },
      { category: "Shopping", previousAmount: 400000, newAmount: 500000 },
    ]));
    expect(f.held()).toBe(false);
  });

  it("writes no baseline cell when the single atomic range update is rejected", () => {
    const f = fixture();
    const realGetRange = f.budgeting.getRange.bind(f.budgeting);
    f.budgeting.getRange = ((...args: unknown[]) => {
      const range = (realGetRange as (...rangeArgs: unknown[]) => GoogleAppsScript.Spreadsheet.Range)(...args);
      if (args[0] === "E2:E50") {
        range.setValues = () => { throw new Error("atomic write rejected"); };
      }
      return range;
    }) as typeof f.budgeting.getRange;

    expect(() => applyApprovedBaselineChange(reviewCommand(), f.deps)).toThrow("atomic write rejected");
    expect(realGetRange("E2:E3").getValues()).toEqual([[600000], [400000]]);
  });

  it("rejects a baseline cell that changed since it was reviewed", () => {
    const f = fixture();
    // The reviewer captured Dining at 600000, but the sheet now holds a different value.
    f.budgeting.getRange("E2").setValue(550000);
    expect(() => applyApprovedBaselineChange(reviewCommand(), f.deps)).toThrow("BASELINE_CELL_STALE");
    expect(f.budgeting.getRange("E2:E3").getValues()).toEqual([[550000], [400000]]);
  });

  it("rejects a baseline cell changed by a competing writer just as the lock is acquired", () => {
    const f = fixture();
    f.onAcquire(() => { f.budgeting.getRange("E3").setValue(999999); });
    expect(() => applyApprovedBaselineChange(reviewCommand(), f.deps)).toThrow("BASELINE_CELL_STALE");
    expect(f.budgeting.getRange("E2:E3").getValues()).toEqual([[600000], [999999]]);
  });

  it("rejects a category that maps to more than one baseline row instead of guessing which to overwrite", () => {
    const f = fixture();
    // Reintroduce an ambiguous duplicate "Dining" row alongside the original.
    f.budgeting.getRange("D4:E4").setValues([["Dining", 50000]]);
    expect(() => applyApprovedBaselineChange(reviewCommand(), f.deps)).toThrow("BASELINE_CELL_STALE");
    expect(f.budgeting.getRange("E2:E4").getValues()).toEqual([[600000], [400000], [50000]]);
  });

  it("rejects a category missing from the calibrated baseline range", () => {
    const f = fixture();
    expect(() => applyApprovedBaselineChange(reviewCommand({
      changes: [
        { category: "Dining", expectedAmount: 600000, newAmount: 500000 },
        { category: "Unknown", expectedAmount: 400000, newAmount: 500000 },
      ],
    }), f.deps)).toThrow("BASELINE_CELL_STALE");
    expect(f.budgeting.getRange("E2:E3").getValues()).toEqual([[600000], [400000]]);
  });

  it("is idempotent when the same approval is replayed after already being applied", () => {
    const f = fixture();
    const first = applyApprovedBaselineChange(reviewCommand(), f.deps);
    const second = applyApprovedBaselineChange(reviewCommand(), f.deps);
    expect(second).toEqual(first);
    expect(f.budgeting.getRange("E2:E3").getValues()).toEqual([[500000], [500000]]);
  });

  it("rejects a change set that does not sum to zero before touching the sheet", () => {
    const f = fixture();
    expect(() => applyApprovedBaselineChange(reviewCommand({
      changes: [
        { category: "Dining", expectedAmount: 600000, newAmount: 500000 },
        { category: "Shopping", expectedAmount: 400000, newAmount: 600000 },
      ],
    }), f.deps)).toThrow("INVALID_INPUT");
    expect(f.budgeting.getRange("E2:E3").getValues()).toEqual([[600000], [400000]]);
  });

  it("never accepts the protected savings category as a change target", () => {
    const f = fixture();
    expect(() => applyApprovedBaselineChange(reviewCommand({
      changes: [
        { category: "Savings", expectedAmount: 200000, newAmount: 100000 },
        { category: "Shopping", expectedAmount: 400000, newAmount: 500000 },
      ],
    }), f.deps)).toThrow("INVALID_INPUT");
  });
});
