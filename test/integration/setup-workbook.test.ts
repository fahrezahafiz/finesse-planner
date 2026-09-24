import { describe, expect, it } from "vitest";
import { setupPlanningSheets } from "../../src/server/workbook/setup";
import { readPlanningSnapshot } from "../../src/server/workbook/snapshot-reader";
import { jakartaClock } from "../../src/domain/time";
import { planningWorkbook, MemorySheet } from "../helpers/planning-workbook";

const clock = jakartaClock(new Date("2026-09-23T00:00:00Z"));
function ready() {
  const f = planningWorkbook(); setupPlanningSheets(f.auth, f.map);
  const s = f.sheets.get("Ringkasan Perencanaan")!;
  s.getRange("A2:H2").setValues([["Dining", 500000, 0, 0, 500000, 0, 0, 500000]]);
  s.getRange("K1:K12").setValues([[1000000], [0], [1000000], [200000], [500000], [500000], [300000], [300000], ["HEALTHY"], [0], ["2026-09"], ["2026-09-23"]]);
  return { ...f, summary: s };
}

describe("planning workbook setup", () => {
  it("creates exactly four planning sheets idempotently and preserves ledger data", () => {
    const f = planningWorkbook(); setupPlanningSheets(f.auth, f.map);
    f.sheets.get("Rencana Pengeluaran")!.getRange("F2").setValue("Existing purchase");
    setupPlanningSheets(f.auth, f.map);
    expect(f.created).toEqual(["Rencana Pengeluaran", "Transfer Budget", "Pendapatan Diharapkan", "Ringkasan Perencanaan"]);
    expect(f.sheets.get("Rencana Pengeluaran")!.getRange("F2").getValue()).toBe("Existing purchase");
    expect(f.sheets.get("Rencana Pengeluaran")!.getRange("A1:U1").getValues()[0]).toEqual(["Plan ID", "Created at", "Created by", "Budget month", "Planned date", "Item", "Category", "Payment account", "Amount", "Status", "Verdict", "Failed guardrails", "Category before", "Category after", "Savings before", "Savings after", "Account before", "Account after", "Override reason", "Completed at", "Actual transaction key"]);
    expect(f.sheets.get("Transfer Budget")!.getRange("A1:K1").getValues()[0]).toEqual(["Transfer ID", "Created at", "Created by", "Budget month", "From category", "To category", "Amount", "Reason", "Related plan ID", "Status", "Reversal reference"]);
    for (const name of f.created) {
      const s = f.sheets.get(name)!;
      expect(s.frozen).toBe(1); expect(s.protections).toHaveLength(1);
      expect(s.protections[0].warning).toBe(false); expect(s.protections[0].domain).toBe(false);
      expect(s.protections[0].editors).toEqual(["first@example.test", "second@example.test"]);
    }
    expect(f.names.get("FP_ACTUAL_INCOME_DATE").getA1Notation()).toBe("B2:B50");
    expect(f.names.get("FP_HEADROOM").getA1Notation()).toBe("K7");
    expect(f.sheets.get("Rencana Pengeluaran")!.formats.get("I2:R1001")).toBe("#,##0");
  });
  it("preflights all existing headers before any write", () => {
    const f = planningWorkbook(); const broken = new MemorySheet("Transfer Budget");
    broken.getRange("A1").setValue("Unknown layout"); f.sheets.set(broken.name, broken);
    expect(() => setupPlanningSheets(f.auth, f.map)).toThrow("WORKBOOK_SCHEMA_INVALID");
    expect(f.created).toEqual([]); expect(broken.getRange("A1").getValue()).toBe("Unknown layout");
  });
  it("fails closed before setup when a source map is absent", () => {
    const f = planningWorkbook(); expect(() => setupPlanningSheets(f.auth)).toThrow("WORKBOOK_SCHEMA_INVALID"); expect(f.created).toEqual([]);
  });
  it("rejects unsupported multi-cell savings before creating sheets", () => {
    const f = planningWorkbook(); const map = { ...f.map, savingsProfile: { ...f.map.savingsProfile, protectedMonthlySavings: { ...f.map.savingsProfile.protectedMonthlySavings, a1: "D2:D3" } } };
    expect(() => setupPlanningSheets(f.auth, map)).toThrow("WORKBOOK_SCHEMA_INVALID"); expect(f.created).toEqual([]);
  });
  it("rejects unexpected summary header extensions on repeated setup", () => {
    const f = ready(); f.summary.getRange("L1").setValue("Unrecognized output");
    expect(() => setupPlanningSheets(f.auth, f.map)).toThrow("WORKBOOK_SCHEMA_INVALID");
  });
});

describe("snapshot reader", () => {
  it("reads aggregated duplicate categories and integer IDR from visible summary outputs", () => {
    const f = ready(); const result = readPlanningSnapshot(f.auth, clock, f.map);
    expect(result.health).toBe("HEALTHY"); expect(result.categories.Dining.baselineBudget).toBe(500000);
    expect(result.actualIncome).toBe(1000000); expect(result.unallocatedHeadroom).toBe(300000);
    expect(result.accounts["Main Account"].currentBalance).toBe(1000000);
  });
  it.each(["", "#REF!", "#DIV/0!", "1000000", NaN, Infinity, 1.5])("never turns invalid required value %s into zero", value => {
    const f = ready(); f.summary.getRange("K1").setValue(value);
    const result = readPlanningSnapshot(f.auth, clock, f.map);
    expect(result.health).toBe("FORMULA_ERROR"); expect(Number.isNaN(result.actualIncome)).toBe(true);
  });
  it.each([["K10", 1, "TRANSFER_RECONCILIATION_ERROR"], ["K11", "2026-08", "STALE_PLANNING_MONTH"], ["K12", "2026-09-22", "STALE_PLANNING_MONTH"], ["K7", -1, "UNDERFUNDED"]])("rejects invalid summary %s", (cell, value, health) => {
    const f = ready(); f.summary.getRange(String(cell)).setValue(value);
    expect(readPlanningSnapshot(f.auth, clock, f.map).health).toBe(health);
  });
  it.each([["Atur Budgeting", "E2", ""], ["backend", "C2", "#REF!"], ["backend", "G2", "2026-09-22"]])("rejects unhealthy source %s %s", (sheet, cell, value) => {
    const f = ready(); f.sheets.get(sheet)!.getRange(cell).setValue(value);
    expect(readPlanningSnapshot(f.auth, clock, f.map).health).not.toBe("HEALTHY");
  });
  it("rejects missing formulas and ledger rows outside bounded capacity", () => {
    const f = ready(); f.summary.formulas.delete("1,11");
    expect(readPlanningSnapshot(f.auth, clock, f.map).health).toBe("FORMULA_ERROR");
    const other = ready(); other.sheets.get("Rencana Pengeluaran")!.getRange("A1002").setValue("overflow");
    expect(readPlanningSnapshot(other.auth, clock, other.map).health).toBe("WORKBOOK_SCHEMA_INVALID");
  });
  it("reconciles a zero-sum current-month transfer while ignoring another month", () => {
    const f = ready();
    f.sheets.get("Atur Budgeting")!.getRange("D4:E4").setValues([["Shopping", 200000]]);
    f.sheets.get("Transfer Budget")!.getRange("A2:K4").setValues([
      ["t1", "", "", "2026-09", "Dining", "Shopping", 100000, "Need", "", "ACTIVE", ""],
      ["t2", "", "", "2026-08", "Dining", "Shopping", 70000, "Old", "", "ACTIVE", ""],
      ["t3", "", "", "2026-09", "Dining", "Shopping", 50000, "Reversed", "", "REVERSED", ""],
    ]);
    f.summary.getRange("A2:H3").setValues([["Dining", 500000, 0, 100000, 400000, 0, 0, 400000], ["Shopping", 200000, 100000, 0, 300000, 0, 0, 300000]]);
    f.summary.getRange("K5:K8").setValues([[700000], [700000], [100000], [100000]]);
    const result = readPlanningSnapshot(f.auth, clock, f.map);
    expect(result.health).toBe("HEALTHY"); expect(result.totalAdjustedBudgets).toBe(700000);
    expect(result.categories.Dining.adjustedBudget).toBe(400000); expect(result.categories.Shopping.adjustedBudget).toBe(300000);
  });
  it("counts only current-month income and eligible confirmed future income", () => {
    const f = ready();
    const source = f.sheets.get("Catat - Pendapatan")!;
    source.getRange("B3:B4").setValues([[new Date("2026-08-31T16:59:59Z")], [new Date("2026-09-30T17:00:00Z")]]);
    source.getRange("F3:F4").setValues([[900000], [900000]]);
    const income = f.sheets.get("Pendapatan Diharapkan")!;
    const row = (id: string, date: string, status: string) => [id, "", "", new Date(date), "Salary", "Main Account", 100000, status, ""];
    income.getRange("A2:I7").setValues([
      row("i1", "2026-09-23T00:00:00+07:00", "CONFIRMED"),
      row("i2", "2026-09-30T00:00:00+07:00", "CONFIRMED"),
      row("i3", "2026-09-22T00:00:00+07:00", "CONFIRMED"),
      row("i4", "2026-10-01T00:00:00+07:00", "CONFIRMED"),
      row("i5", "2026-09-23T00:00:00+07:00", "RECEIVED"),
      row("i6", "2026-09-23T00:00:00+07:00", "CANCELLED"),
    ]);
    f.summary.getRange("K2:K3").setValues([[200000], [1200000]]);
    f.summary.getRange("K7:K8").setValues([[500000], [500000]]);
    const result = readPlanningSnapshot(f.auth, clock, f.map);
    expect(result.health).toBe("HEALTHY"); expect(result.actualIncome).toBe(1000000); expect(result.confirmedFutureIncome).toBe(200000);
    expect(result.confirmedIncome).toEqual([
      { amount: 100000, destinationAccount: "Main Account", expectedDate: "2026-09-23" },
      { amount: 100000, destinationAccount: "Main Account", expectedDate: "2026-09-30" },
    ]);
  });
  it("reserves RESERVED and OVERRIDDEN only, and replaces completed reservations with actuals", () => {
    const f = ready(); const plans = f.sheets.get("Rencana Pengeluaran")!;
    const row = (id: string, month: string, status: string) => [id, "", "", month, new Date("2026-09-24T00:00:00+07:00"), "Dinner", "Dining", "Main Account", 50000, status, "", "", "", "", "", "", "", "", "", "", ""];
    plans.getRange("A2:U7").setValues([row("p1", "2026-09", "RESERVED"), row("p2", "2026-09", "OVERRIDDEN"), row("p3", "2026-09", "COMPLETED"), row("p4", "2026-09", "CANCELLED"), row("p5", "2026-09", "EXPIRED"), row("p6", "2026-08", "RESERVED")]);
    f.sheets.get("Catat - Pengeluaran")!.getRange("B2:F2").setValues([[new Date("2026-09-20T00:00:00+07:00"), "Dining", "Dinner", "Main Account", 50000]]);
    f.summary.getRange("F2:H2").setValues([[50000, 100000, 350000]]);
    const result = readPlanningSnapshot(f.auth, clock, f.map);
    expect(result.health).toBe("HEALTHY"); expect(result.categories.Dining.activeReservations).toBe(100000); expect(result.categories.Dining.availableBudget).toBe(350000);
    expect(result.activeReservations).toEqual([
      { actionId: "p1", amount: 50000, paymentAccount: "Main Account", plannedDate: "2026-09-24" },
      { actionId: "p2", amount: 50000, paymentAccount: "Main Account", plannedDate: "2026-09-24" },
    ]);
  });
  it("rejects a stale same-day numeric result and missing category output", () => {
    const f = ready(); f.summary.getRange("B2").setValue(400000);
    expect(readPlanningSnapshot(f.auth, clock, f.map).health).toBe("FORMULA_ERROR");
    const other = ready(); other.summary.getRange("A2:H2").setValues([["", "", "", "", "", "", "", ""]]);
    expect(readPlanningSnapshot(other.auth, clock, other.map).health).toBe("FORMULA_ERROR");
  });
  it("rejects a named source range redirected outside its calibrated location", () => {
    const f = ready(); f.names.set("FP_ACTUAL_INCOME_AMOUNT", f.sheets.get("Catat - Pendapatan")!.getRange("F3:F50"));
    expect(readPlanningSnapshot(f.auth, clock, f.map).health).toBe("WORKBOOK_SCHEMA_INVALID");
  });
  it("rejects source schema without a map", () => {
    const f = ready(); expect(readPlanningSnapshot(f.auth, clock).health).toBe("WORKBOOK_SCHEMA_INVALID");
  });
  it.each(["Rencana Pengeluaran", "Transfer Budget"])("rejects Date-valued budget months in %s even when cached totals match", name => {
    const f = ready(); const month = new Date("2026-09-23T00:00:00+07:00");
    // Inactive records isolate the month-type contract from amount reconciliation:
    // the old reader accepted both and returned HEALTHY.
    if (name === "Rencana Pengeluaran") {
      f.sheets.get(name)!.getRange("A2:J2").setValues([["p1", "", "", month, new Date("2026-09-24T00:00:00+07:00"), "Dinner", "Dining", "Main Account", 50000, "CANCELLED"]]);
    } else {
      f.sheets.get(name)!.getRange("A2:K2").setValues([["t1", "", "", month, "Dining", "Shopping", 50000, "Reversed", "", "REVERSED", ""]]);
    }
    expect(readPlanningSnapshot(f.auth, clock, f.map).health).toBe("FORMULA_ERROR");
  });
  it("accepts literal adversarial categories without merging wildcard or case-distinct names", () => {
    const f = ready(); const labels = ["Food*", "Food?", "Food", "food", ">Food", "=Food", "<>Food"];
    f.sheets.get("Atur Budgeting")!.getRange("D2:E8").setValues(labels.map(label => [label, 100000]));
    f.summary.getRange("A2:H8").setValues(labels.map(label => [label, 100000, 0, 0, 100000, 0, 0, 100000]));
    f.summary.getRange("K5:K8").setValues([[700000], [700000], [100000], [100000]]);
    const result = readPlanningSnapshot(f.auth, clock, f.map);
    expect(result.health).toBe("HEALTHY"); expect(Object.keys(result.categories)).toEqual(labels);
    for (const label of labels) expect(result.categories[label].baselineBudget).toBe(100000);
  });
});
