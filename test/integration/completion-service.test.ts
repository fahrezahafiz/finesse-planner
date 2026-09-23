import { describe, expect, it } from "vitest";
import { reservePurchase, cancelPlan } from "../../src/server/services/plan-service";
import { completePlan } from "../../src/server/services/completion-service";
import { PlanRepository } from "../../src/server/workbook/plan-repository";
import { setupPlanningSheets } from "../../src/server/workbook/setup";
import { jakartaClock } from "../../src/domain/time";
import { planningWorkbook } from "../helpers/planning-workbook";
import { installFakeSheetsApi } from "../helpers/fake-apps-script";

function fixture() {
  const f = planningWorkbook(); setupPlanningSheets(f.auth, f.map);
  const ledger = f.sheets.get("Rencana Pengeluaran")!;
  const summary = f.sheets.get("Ringkasan Perencanaan")!;
  const expenses = f.sheets.get("Catat - Pengeluaran")!;
  f.sheets.get("Atur Budgeting")!.getRange("D2:E3").setValues([["Dining", 600000], ["Dining", 400000]]);
  f.sheets.get("Catat - Pendapatan")!.getRange("F2").setValue(3000000);
  f.sheets.get("backend")!.getRange("C2").setValue(3000000);
  let held = false;
  let onAcquire = () => {};
  const lock = { tryLock: (_ms: number) => { if (held) return false; held = true; onAcquire(); return true; }, releaseLock: () => { held = false; } };
  // Simulates only the external Sheets recalculation boundary; repository, snapshot reader,
  // validation, and the completion service all run as production code.
  const flush = () => {
    const reserved = ledger.getRange("A2:U1001").getValues()
      .filter((r: any[]) => r[0] !== "" && r[3] === deps.clock.month && ["RESERVED", "OVERRIDDEN"].includes(r[9]))
      .reduce((sum: number, r: any[]) => sum + r[8], 0);
    const spent = expenses.getRange("B2:F50").getValues()
      .filter((r: any[]) => r[1] === "Dining" && jakartaClock(r[0]).month === deps.clock.month)
      .reduce((sum: number, r: any[]) => sum + r[4], 0);
    summary.getRange("A2:H2").setValues([["Dining", 1000000, 0, 0, 1000000, spent, reserved, 1000000 - spent - reserved]]);
    summary.getRange("K1:K12").setValues([[3000000], [0], [3000000], [200000], [1000000], [1000000], [1800000], [1800000], ["HEALTHY"], [0], [deps.clock.month], [deps.clock.today]]);
  };
  const deps = { auth: f.auth, clock: jakartaClock(new Date("2026-09-23T00:00:00Z")), sourceMap: f.map, lock, flush };
  flush();
  const sheetsById = () => new Map([...f.sheets.values()].map(sheet => [sheet.getSheetId(), sheet]));
  const controller = installFakeSheetsApi(f.workbook.getId(), sheetsById, flush);
  return {
    ...f, ledger, summary, expenses, deps, flush,
    repository: new PlanRepository(f.auth),
    held: () => held, onAcquire: (fn: () => void) => { onAcquire = fn; },
    expenseRows: () => expenses.getRange("B2:F50").getValues().filter((r: any[]) => r[1] !== ""),
    metadataCount: () => controller.metadataCount(),
    failOnceAfterAtomicExpenseAppend: () => controller.commitThenThrowNextBatchUpdate(),
    rejectNextExpenseAppend: () => controller.rejectNextBatchUpdate(),
  };
}

function reserveCommand(overrides: Record<string, unknown> = {}) {
  return { actionId: "action-1", item: "Headphones", amount: 700000, category: "Dining", plannedDate: "2026-09-24", paymentAccount: "Main Account", ...overrides };
}
function completeCommand(actionId: string) {
  return { actionId };
}

describe("completion service using the authorized workbook", () => {
  it("returns the existing transaction after a repeated completion request", () => {
    const f = fixture();
    reservePurchase(reserveCommand({ actionId: "action-1" }), f.deps);
    const first = completePlan(completeCommand("action-1"), f.deps);
    const second = completePlan(completeCommand("action-1"), f.deps);
    expect(first.status).toBe("COMPLETED");
    expect(first.actualTransactionKey).toBe(second.actualTransactionKey);
    expect(first.completedAt).toBe(second.completedAt);
    expect(f.expenseRows()).toHaveLength(1);
    expect(f.metadataCount()).toBe(1);
    expect(f.held()).toBe(false);
  });

  it("reconciles after the atomic append succeeded but plan finalization failed", () => {
    const f = fixture();
    reservePurchase(reserveCommand({ actionId: "action-2" }), f.deps);
    f.failOnceAfterAtomicExpenseAppend();
    expect(() => completePlan(completeCommand("action-2"), f.deps)).toThrow();
    expect(f.repository.list().find(plan => plan.actionId === "action-2")!.status).toBe("RESERVED");
    expect(f.expenseRows()).toHaveLength(1); // the row was truly written before the dropped acknowledgment
    expect(f.held()).toBe(false);

    const retry = completePlan(completeCommand("action-2"), f.deps);
    expect(retry.status).toBe("COMPLETED");
    expect(f.expenseRows()).toHaveLength(1); // no duplicate append on retry
    expect(f.metadataCount()).toBe(1);
  });

  it("never marks a plan completed when the underlying expense append is rejected outright", () => {
    const f = fixture();
    reservePurchase(reserveCommand({ actionId: "action-3" }), f.deps);
    f.rejectNextExpenseAppend();
    expect(() => completePlan(completeCommand("action-3"), f.deps)).toThrow();

    const plan = f.repository.list().find(entry => entry.actionId === "action-3")!;
    expect(plan.status).toBe("RESERVED");
    expect(plan.completedAt).toBeNull();
    expect(plan.actualTransactionKey).toBe("");
    expect(f.expenseRows()).toHaveLength(0);
    expect(f.metadataCount()).toBe(0);
  });

  it("persists exact date, category, detail, account, and amount types for the actual expense", () => {
    const f = fixture();
    reservePurchase(reserveCommand({ actionId: "action-4", item: "Dinner out", amount: 250000, plannedDate: "2026-09-25" }), f.deps);
    completePlan(completeCommand("action-4"), f.deps);
    const row = f.expenses.getRange("B2:F2").getValues()[0];
    expect(row[0]).toEqual(new Date(`${f.deps.clock.today}T00:00:00+07:00`));
    expect(row[0]).not.toEqual("2026-09-23"); // a real Sheets date, not text that looks like one
    expect(row[1]).toBe("Dining");
    expect(row[2]).toBe("Dinner out");
    expect(row[3]).toBe("Main Account");
    expect(row[4]).toBe(250000);
    expect(typeof row[4]).toBe("number");
  });

  it("rejects completing a plan that is not RESERVED or OVERRIDDEN", () => {
    const f = fixture();
    reservePurchase(reserveCommand({ actionId: "action-5" }), f.deps);
    cancelPlan({ actionId: "action-5" }, f.deps);
    expect(() => completePlan(completeCommand("action-5"), f.deps)).toThrow("INVALID_INPUT");
    expect(f.expenseRows()).toHaveLength(0);
  });

  it("rejects completing an unknown action ID", () => {
    const f = fixture();
    expect(() => completePlan(completeCommand("missing"), f.deps)).toThrow("INVALID_INPUT");
  });

  it("fails closed when the snapshot is unhealthy at completion time", () => {
    const f = fixture();
    reservePurchase(reserveCommand({ actionId: "action-6" }), f.deps);
    f.sheets.get("backend")!.getRange("G2").setValue("2026-09-22"); // stale formula freshness
    expect(() => completePlan(completeCommand("action-6"), f.deps)).toThrow("WORKBOOK_SCHEMA_INVALID");
    expect(f.expenseRows()).toHaveLength(0);
  });
});
