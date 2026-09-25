import { describe, expect, it } from "vitest";
import { checkPurchase, reservePurchase, overridePurchase, cancelPlan, expirePastPlans } from "../../src/server/services/plan-service";
import { PlanRepository } from "../../src/server/workbook/plan-repository";
import { setupPlanningSheets } from "../../src/server/workbook/setup";
import { jakartaClock } from "../../src/domain/time";
import { planningWorkbook } from "../helpers/planning-workbook";
import { installFakeSheetsApi } from "../helpers/fake-apps-script";

function fixture() {
  const f = planningWorkbook(); setupPlanningSheets(f.auth, f.map);
  const ledger = f.sheets.get("Rencana Pengeluaran")!;
  const summary = f.sheets.get("Ringkasan Perencanaan")!;
  f.sheets.get("Atur Budgeting")!.getRange("D2:E3").setValues([["Dining", 600000], ["Dining", 400000]]);
  f.sheets.get("Catat - Pendapatan")!.getRange("F2").setValue(3000000);
  f.sheets.get("backend")!.getRange("C2").setValue(3000000);
  let held = false;
  let onAcquire = () => {};
  const lock = { tryLock: (_ms: number) => { if (held) return false; held = true; onAcquire(); return true; }, releaseLock: () => { held = false; } };
  // Simulates only the external Sheets recalculation boundary; repository, snapshot reader,
  // validation and recommendation all run as production code.
  const flush = () => {
    const reserved = ledger.getRange("A2:U1001").getValues().filter((r: any[]) => r[3] === deps.clock.month && ["RESERVED", "OVERRIDDEN"].includes(r[9])).reduce((sum: number, r: any[]) => sum + r[8], 0);
    summary.getRange("A2:H2").setValues([["Dining", 1000000, 0, 0, 1000000, 0, reserved, 1000000 - reserved]]);
    summary.getRange("K1:K12").setValues([[3000000], [0], [3000000], [200000], [1000000], [1000000], [1800000], [1800000], ["HEALTHY"], [0], [deps.clock.month], [deps.clock.today]]);
  };
  const deps = { auth: f.auth, clock: jakartaClock(new Date("2026-09-23T00:00:00Z")), sourceMap: f.map, lock, flush };
  flush();
  installFakeSheetsApi(f.workbook.getId(), () => new Map([...f.sheets.values()].map(sheet => [sheet.getSheetId(), sheet])), flush);
  return { ...f, ledger, summary, deps, flush, repository: new PlanRepository(f.auth), held: () => held, onAcquire: (fn: () => void) => { onAcquire = fn; } };
}
function command(overrides: Record<string, unknown> = {}) {
  return { actionId: "action-1", item: "Headphones", amount: 700000, category: "Dining", plannedDate: "2026-09-24", paymentAccount: "Main Account", ...overrides };
}

describe("plan service using the authorized workbook", () => {
  it("checks without creating a reservation", () => {
    const f = fixture();
    expect(checkPurchase(command(), f.deps).verdict).toBe("RECOMMENDED");
    expect(f.repository.list()).toEqual([]);
  });
  it("allows at most one of two distinct reservations that cannot both fit", () => {
    const f = fixture();
    expect(reservePurchase(command(), f.deps).status).toBe("RESERVED");
    expect(() => reservePurchase(command({ actionId: "action-2" }), f.deps)).toThrow("CATEGORY_BUDGET_EXCEEDED");
    expect(f.repository.list()).toHaveLength(1);
    expect(f.held()).toBe(false);
  });
  it("returns the same durable row on duplicate action IDs even when requested values differ", () => {
    const f = fixture(); const first = reservePurchase(command(), f.deps);
    expect(reservePurchase(command({ amount: 200000 }), f.deps)).toEqual(first);
    expect(f.repository.list()).toHaveLength(1);
  });
  it("replays an existing ID across month rollover without treating its old proposal date as a new purchase", () => {
    const f = fixture(); const first = reservePurchase(command(), f.deps);
    f.deps.clock = jakartaClock(new Date("2026-09-30T17:00:00Z"));
    f.sheets.get("backend")!.getRange("G2").setValue("2026-10-01");
    f.sheets.get("Catat - Pendapatan")!.getRange("B2").setValue(new Date("2026-10-01T00:00:00+07:00"));
    expect(reservePurchase(command(), f.deps)).toEqual({ ...first, status: "EXPIRED" });
    expect(f.repository.list()).toHaveLength(1);
  });
  it("does not duplicate a row after persistence succeeded but the response was interrupted", () => {
    const f = fixture(); const realFlush = f.deps.flush;
    f.deps.flush = () => { realFlush(); if (f.ledger.getRange("A2").getValue()) throw new Error("response interrupted"); };
    expect(() => reservePurchase(command(), f.deps)).toThrow("response interrupted");
    f.deps.flush = realFlush;
    expect(reservePurchase(command(), f.deps).status).toBe("RESERVED");
    expect(f.repository.list()).toHaveLength(1); expect(f.held()).toBe(false);
  });
  it("rereads changes made between an earlier check and lock acquisition", () => {
    const f = fixture(); expect(checkPurchase(command(), f.deps).verdict).toBe("RECOMMENDED");
    f.onAcquire(() => f.sheets.get("backend")!.getRange("C2").setValue(100000));
    expect(() => reservePurchase(command(), f.deps)).toThrow();
    expect(f.repository.list()).toEqual([]);
  });
  it("requires a reason for an override", () => {
    const f = fixture();
    expect(() => overridePurchase(command({ reason: "  " }), f.deps)).toThrow("OVERRIDE_REASON_REQUIRED");
    expect(f.repository.list()).toEqual([]);
  });
  it("reserves an overridden purchase while preserving the failed original decision and snapshots", () => {
    const f = fixture(); const plan = overridePurchase(command({ amount: 1200000, reason: "Necessary replacement" }), f.deps);
    expect(plan.status).toBe("OVERRIDDEN"); expect(plan.verdict).toBe("NOT_RECOMMENDED");
    expect(plan.failedGuardrails).toEqual(["CATEGORY_AVAILABILITY"]);
    expect([plan.categoryBefore, plan.categoryAfter, plan.savingsBefore, plan.savingsAfter, plan.accountBefore, plan.accountAfter]).toEqual([1000000, -200000, 2000000, 1800000, 3000000, 1800000]);
    expect(f.summary.getRange("G2:H2").getValues()).toEqual([[1200000, -200000]]);
    expect(() => reservePurchase(command({ actionId: "action-2", amount: 1 }), f.deps)).toThrow("CATEGORY_BUDGET_EXCEEDED");
  });
  it("cancels once, releases reserved capacity, and replays the durable cancelled row", () => {
    const f = fixture(); const original = reservePurchase(command(), f.deps);
    const cancelled = cancelPlan({ actionId: "action-1" }, f.deps);
    expect(cancelled).toEqual({ ...original, status: "CANCELLED" });
    expect(cancelPlan({ actionId: "action-1" }, f.deps)).toEqual(cancelled);
    expect(reservePurchase(command(), f.deps)).toEqual(cancelled);
    expect(f.repository.list()).toHaveLength(1);
    expect(reservePurchase(command({ actionId: "action-2" }), f.deps).status).toBe("RESERVED");
  });
  it.each(["COMPLETED", "EXPIRED"])("rejects cancellation of terminal %s history", status => {
    const f = fixture(); reservePurchase(command(), f.deps);
    f.ledger.getRange("J2").setValue(status);
    if (status === "COMPLETED") f.ledger.getRange("T2:U2").setValues([[new Date("2026-09-24T00:00:00+07:00"), "transaction-1"]]);
    f.flush();
    expect(() => cancelPlan({ actionId: "action-1" }, f.deps)).toThrow("INVALID_INPUT");
    expect(f.ledger.getRange("J2").getValue()).toBe(status);
  });
  it("expires both active statuses using the captured Jakarta rollover month and retains history", () => {
    const f = fixture(); reservePurchase(command({ amount: 100000 }), f.deps);
    overridePurchase(command({ actionId: "action-2", amount: 1100000, reason: "Replacement" }), f.deps);
    f.deps.clock = jakartaClock(new Date("2026-09-30T17:00:00Z"));
    f.sheets.get("backend")!.getRange("G2").setValue("2026-10-01");
    f.sheets.get("Catat - Pendapatan")!.getRange("B2").setValue(new Date("2026-10-01T00:00:00+07:00"));
    const expired = expirePastPlans({ actionId: "rollover-1" }, f.deps);
    expect(expired.map(plan => plan.status)).toEqual(["EXPIRED", "EXPIRED"]);
    expect(f.repository.list()).toHaveLength(2);
    expect(expirePastPlans({ actionId: "rollover-1" }, f.deps)).toEqual(expired);
  });
  it("expires old plans before reading a new month's purchase snapshot", () => {
    const f = fixture(); reservePurchase(command(), f.deps);
    f.deps.clock = jakartaClock(new Date("2026-09-30T17:00:00Z"));
    f.sheets.get("backend")!.getRange("G2").setValue("2026-10-01");
    f.sheets.get("Catat - Pendapatan")!.getRange("B2").setValue(new Date("2026-10-01T00:00:00+07:00"));
    expect(reservePurchase(command({ actionId: "action-2", plannedDate: "2026-10-01" }), f.deps).status).toBe("RESERVED");
    expect(f.repository.list().map(plan => plan.status)).toEqual(["EXPIRED", "RESERVED"]);
  });
  it("persists canonical month text, real Sheet dates, and exact numeric IDR", () => {
    const f = fixture(); reservePurchase(command(), f.deps);
    const row = f.ledger.getRange("A2:U2").getValues()[0];
    expect(row[0]).toBe("action-1"); expect(row[2]).toBe("first@example.test");
    expect(row[3]).toBe("2026-09"); expect(row[4]).toEqual(new Date("2026-09-24T00:00:00+07:00"));
    expect(row[1]).toEqual(new Date("2026-09-23T00:00:00Z")); expect(row[8]).toBe(700000);
  });
  it.each([["I2", "700000"], ["D2", new Date("2026-09-01")], ["J2", "UNKNOWN"], ["L2", "not JSON"], ["M2", 1.5]])("fails closed on corrupt repository cell %s", (cell, value) => {
    const f = fixture(); reservePurchase(command(), f.deps); f.ledger.getRange(String(cell)).setValue(value);
    expect(() => reservePurchase(command({ actionId: "action-2" }), f.deps)).toThrow("WORKBOOK_SCHEMA_INVALID");
    expect(f.ledger.getRange("A3").getValue()).toBe("");
  });
  it("rejects formula-valued ledger data even when its cached value looks valid", () => {
    const f = fixture(); reservePurchase(command(), f.deps); f.ledger.getRange("I2").setFormula("=700000");
    expect(() => cancelPlan({ actionId: "action-1" }, f.deps)).toThrow("WORKBOOK_SCHEMA_INVALID");
  });
  it("rejects duplicate stored IDs instead of choosing an arbitrary prior action", () => {
    const f = fixture(); reservePurchase(command(), f.deps);
    f.ledger.getRange("A3:U3").setValues(f.ledger.getRange("A2:U2").getValues());
    expect(() => reservePurchase(command(), f.deps)).toThrow("WORKBOOK_SCHEMA_INVALID");
  });
  it("does not allow repository updates to revive terminal history", () => {
    const f = fixture(); reservePurchase(command(), f.deps); const cancelled = cancelPlan({ actionId: "action-1" }, f.deps);
    expect(() => f.repository.update({ ...cancelled, status: "RESERVED" })).toThrow("WORKBOOK_SCHEMA_INVALID");
    expect(f.repository.list()[0].status).toBe("CANCELLED");
  });
  it("rejects inconsistent original guardrail snapshots", () => {
    const f = fixture(); reservePurchase(command(), f.deps); f.ledger.getRange("N2").setValue(999999);
    expect(() => reservePurchase(command(), f.deps)).toThrow("WORKBOOK_SCHEMA_INVALID");
  });
  it("cannot override unknown categories, accounts, or an unhealthy snapshot", () => {
    for (const fields of [{ category: "Unknown" }, { paymentAccount: "Unknown" }, {}]) {
      const f = fixture(); if (!Object.keys(fields).length) f.sheets.get("backend")!.getRange("G2").setValue("2026-09-22");
      expect(() => overridePurchase(command({ ...fields, reason: "Need it" }), f.deps)).toThrow();
      expect(f.repository.list()).toEqual([]);
    }
  });
  it("refuses to overwrite terminal history when the ledger is full", () => {
    const f = fixture(); reservePurchase(command(), f.deps); cancelPlan({ actionId: "action-1" }, f.deps);
    const row = f.ledger.getRange("A2:U2").getValues()[0];
    f.ledger.getRange("A2:U1001").setValues(Array.from({ length: 1000 }, (_, i) => [`full-${i}`, ...row.slice(1)]));
    expect(() => reservePurchase(command({ actionId: "new-plan" }), f.deps)).toThrow("WORKBOOK_SCHEMA_INVALID");
    expect(f.repository.list()).toHaveLength(1000);
  });
});
