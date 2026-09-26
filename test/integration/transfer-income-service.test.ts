import { describe, expect, it } from "vitest";
import { createTransfer, reverseTransfer } from "../../src/server/services/transfer-service";
import { createExpectedIncome, markIncomeReceived, cancelExpectedIncome } from "../../src/server/services/income-service";
import { TransferRepository } from "../../src/server/workbook/transfer-repository";
import { IncomeRepository } from "../../src/server/workbook/income-repository";
import { setupPlanningSheets } from "../../src/server/workbook/setup";
import { jakartaClock } from "../../src/domain/time";
import { planningWorkbook } from "../helpers/planning-workbook";

function fixture() {
  const f = planningWorkbook(); setupPlanningSheets(f.auth, f.map);
  const transfers = f.sheets.get("Transfer Budget")!;
  const income = f.sheets.get("Pendapatan Diharapkan")!;
  const summary = f.sheets.get("Ringkasan Perencanaan")!;
  const expenses = f.sheets.get("Catat - Pengeluaran")!;
  f.sheets.get("Atur Budgeting")!.getRange("D2:E3").setValues([["Dining", 600000], ["Shopping", 400000]]);
  f.sheets.get("Catat - Pendapatan")!.getRange("F2").setValue(3000000);
  f.sheets.get("backend")!.getRange("C2").setValue(3000000);
  let held = false;
  let onAcquire = () => {};
  const lock = { tryLock: (_ms: number) => { if (held) return false; held = true; onAcquire(); return true; }, releaseLock: () => { held = false; } };
  // Simulates only the external Sheets recalculation boundary; repository, snapshot reader,
  // and domain validation all run as production code.
  const flush = () => {
    const month = deps.clock.month, today = deps.clock.today, monthEnd = deps.clock.monthEnd;
    const transferRows = transfers.getRange("A2:K1001").getValues().filter((r: any[]) => r[0] !== "");
    const netFor = (name: string, column: 4 | 5) => transferRows
      .filter((r: any[]) => r[3] === month && r[9] === "ACTIVE" && r[column] === name)
      .reduce((sum: number, r: any[]) => sum + r[6], 0);
    const expenseRows = expenses.getRange("A2:F50").getValues().filter((r: any[]) => r[1] !== "");
    const spentFor = (name: string) => expenseRows
      .filter((r: any[]) => r[2] === name && jakartaClock(r[1]).month === month)
      .reduce((sum: number, r: any[]) => sum + r[5], 0);
    const baselines: [string, number][] = [["Dining", 600000], ["Shopping", 400000]];
    const rows = baselines.map(([name, baseline]) => {
      const transfersIn = netFor(name, 5), transfersOut = netFor(name, 4);
      const adjusted = baseline + transfersIn - transfersOut;
      const spent = spentFor(name);
      return [name, baseline, transfersIn, transfersOut, adjusted, spent, 0, adjusted - spent];
    });
    summary.getRange("A2:H3").setValues(rows);
    const totalBaseline = 1000000;
    const totalAdjusted = rows.reduce((sum, row) => sum + (row[4] as number), 0);
    const incomeRows = income.getRange("A2:I1001").getValues().filter((r: any[]) => r[0] !== "");
    const futureIncome = incomeRows
      .filter((r: any[]) => r[7] === "CONFIRMED" && jakartaClock(r[3]).today >= today && jakartaClock(r[3]).today <= monthEnd)
      .reduce((sum: number, r: any[]) => sum + r[6], 0);
    const actualIncome = 3000000, savings = 200000;
    const recognized = actualIncome + futureIncome;
    const headroom = recognized - savings - totalAdjusted;
    const reconciliation = rows.reduce((sum, row) => sum + (row[2] as number), 0) - rows.reduce((sum, row) => sum + (row[3] as number), 0);
    summary.getRange("K1:K12").setValues([[actualIncome], [futureIncome], [recognized], [savings], [totalBaseline], [totalAdjusted], [headroom], [headroom], ["HEALTHY"], [reconciliation], [deps.clock.month], [deps.clock.today]]);
  };
  const deps = { auth: f.auth, clock: jakartaClock(new Date("2026-09-23T00:00:00Z")), sourceMap: f.map, lock, flush };
  flush();
  return {
    ...f, transfers, income, summary, expenses, deps, flush,
    transferRepository: new TransferRepository(f.auth), incomeRepository: new IncomeRepository(f.auth),
    held: () => held, onAcquire: (fn: () => void) => { onAcquire = fn; },
  };
}

function transferCommand(overrides: Record<string, unknown> = {}) {
  return { actionId: "transfer-1", fromCategory: "Dining", toCategory: "Shopping", amount: 200000, reason: "Cover shopping overage", ...overrides };
}
function incomeCommand(overrides: Record<string, unknown> = {}) {
  return { actionId: "income-1", expectedDate: "2026-09-25", source: "Freelance", destinationAccount: "Main Account", amount: 500000, ...overrides };
}

describe("transfer service using the authorized workbook", () => {
  it("moves budget between categories while preserving the total adjusted budget", () => {
    const f = fixture();
    const totalBefore = f.summary.getRange("E2:E3").getValues().reduce((sum, [v]) => sum + v, 0);
    const transfer = createTransfer(transferCommand(), f.deps);
    expect(transfer.status).toBe("ACTIVE");
    expect(f.summary.getRange("E2:E3").getValues()).toEqual([[400000], [600000]]);
    const totalAfter = f.summary.getRange("E2:E3").getValues().reduce((sum, [v]) => sum + v, 0);
    expect(totalAfter).toBe(totalBefore);
    expect(f.held()).toBe(false);
  });

  it("returns the same durable row on duplicate action IDs even when requested values differ", () => {
    const f = fixture(); const first = createTransfer(transferCommand(), f.deps);
    expect(createTransfer(transferCommand({ amount: 1 }), f.deps)).toEqual(first);
    expect(f.transferRepository.list()).toHaveLength(1);
  });

  it("rejects a transfer larger than donor availability by one rupiah", () => {
    const f = fixture();
    expect(() => createTransfer(transferCommand({ amount: 600001 }), f.deps)).toThrow("DONOR_BUDGET_EXCEEDED");
    expect(f.transferRepository.list()).toEqual([]);
  });

  it("rejects identical donor and recipient categories before touching the ledger", () => {
    const f = fixture();
    expect(() => createTransfer(transferCommand({ toCategory: "Dining" }), f.deps)).toThrow("INVALID_INPUT");
    expect(f.transferRepository.list()).toEqual([]);
  });

  it("rejects the protected-savings category as donor or recipient", () => {
    const f = fixture();
    expect(() => createTransfer(transferCommand({ fromCategory: "Savings" }), f.deps)).toThrow("INVALID_INPUT");
    expect(() => createTransfer(transferCommand({ toCategory: "Savings" }), f.deps)).toThrow("INVALID_INPUT");
    expect(f.transferRepository.list()).toEqual([]);
  });

  it("rejects an unknown category against the fresh snapshot", () => {
    const f = fixture();
    expect(() => createTransfer(transferCommand({ fromCategory: "Unknown" }), f.deps)).toThrow("INVALID_INPUT");
    expect(f.transferRepository.list()).toEqual([]);
  });

  it("rereads a competing transfer written just as the lock is acquired", () => {
    const f = fixture();
    f.onAcquire(() => {
      f.transfers.getRange("A2:K2").setValues([[
        "transfer-0", new Date("2026-09-23T00:00:00Z"), "second@example.test", "2026-09",
        "Dining", "Shopping", 600000, "Prior transfer", "", "ACTIVE", "",
      ]]);
      f.flush();
    });
    expect(() => createTransfer(transferCommand({ amount: 1 }), f.deps)).toThrow("DONOR_BUDGET_EXCEEDED");
    expect(f.transferRepository.list()).toHaveLength(1);
  });

  it("persists canonical month text and real Sheet dates", () => {
    const f = fixture(); createTransfer(transferCommand(), f.deps);
    const row = f.transfers.getRange("A2:K2").getValues()[0];
    expect(row[0]).toBe("transfer-1"); expect(row[2]).toBe("first@example.test");
    expect(row[3]).toBe("2026-09"); expect(row[1]).toEqual(new Date("2026-09-23T00:00:00Z"));
    expect(row[9]).toBe("ACTIVE"); expect(row[10]).toBe("");
  });

  it.each([["D2", new Date("2026-09-01")], ["J2", "UNKNOWN"], ["E2", "Shopping"]])("fails closed on corrupt repository cell %s", (cell, value) => {
    const f = fixture(); createTransfer(transferCommand(), f.deps); f.transfers.getRange(String(cell)).setValue(value);
    expect(() => createTransfer(transferCommand({ actionId: "transfer-2" }), f.deps)).toThrow("WORKBOOK_SCHEMA_INVALID");
  });

  it("rejects duplicate stored IDs instead of choosing an arbitrary prior action", () => {
    const f = fixture(); createTransfer(transferCommand(), f.deps);
    f.transfers.getRange("A3:K3").setValues(f.transfers.getRange("A2:K2").getValues());
    expect(() => createTransfer(transferCommand({ actionId: "transfer-2" }), f.deps)).toThrow("WORKBOOK_SCHEMA_INVALID");
  });

  describe("reversal", () => {
    it("appends a linked reversing row, restores the original categories, and blocks reactivation", () => {
      const f = fixture(); const original = createTransfer(transferCommand(), f.deps);
      const reversal = reverseTransfer({ actionId: "reversal-1", transferId: original.actionId }, f.deps);
      expect(reversal.status).toBe("REVERSED");
      expect(reversal.fromCategory).toBe("Shopping"); expect(reversal.toCategory).toBe("Dining");
      expect(reversal.reversalReference).toBe(original.actionId);
      expect(f.transferRepository.list().find(t => t.actionId === original.actionId)!.status).toBe("REVERSED");
      expect(f.summary.getRange("E2:E3").getValues()).toEqual([[600000], [400000]]);
      expect(() => f.transferRepository.update({ ...f.transferRepository.list()[0], status: "ACTIVE" })).toThrow("WORKBOOK_SCHEMA_INVALID");
    });

    it("returns the same durable reversal on a replayed reversal action ID", () => {
      const f = fixture(); const original = createTransfer(transferCommand(), f.deps);
      const first = reverseTransfer({ actionId: "reversal-1", transferId: original.actionId }, f.deps);
      expect(reverseTransfer({ actionId: "reversal-1", transferId: original.actionId }, f.deps)).toEqual(first);
      expect(f.transferRepository.list()).toHaveLength(2);
    });

    it("does not duplicate the audit row after persistence succeeded but the response was interrupted", () => {
      const f = fixture(); const original = createTransfer(transferCommand(), f.deps);
      const realFlush = f.deps.flush;
      f.deps.flush = () => { realFlush(); throw new Error("response interrupted"); };
      expect(() => reverseTransfer({ actionId: "reversal-1", transferId: original.actionId }, f.deps)).toThrow("response interrupted");
      expect(f.transferRepository.list().find(t => t.actionId === original.actionId)!.status).toBe("REVERSED");
      f.deps.flush = realFlush;
      const reversal = reverseTransfer({ actionId: "reversal-1", transferId: original.actionId }, f.deps);
      expect(reversal.status).toBe("REVERSED");
      expect(f.transferRepository.list()).toHaveLength(2);
    });

    it("resumes a reversal whose audit row persisted but whose original-status flip did not", () => {
      const f = fixture(); const original = createTransfer(transferCommand(), f.deps);
      // Simulate a prior attempt that appended the reversing row but was interrupted before flipping the original.
      f.transferRepository.append({
        ...original, actionId: "reversal-1", fromCategory: original.toCategory, toCategory: original.fromCategory,
        reason: `Reversal of ${original.actionId}`, status: "REVERSED", reversalReference: original.actionId,
      });
      expect(f.transferRepository.list().find(t => t.actionId === original.actionId)!.status).toBe("ACTIVE");
      const reversal = reverseTransfer({ actionId: "reversal-1", transferId: original.actionId }, f.deps);
      expect(reversal.status).toBe("REVERSED");
      expect(f.transferRepository.list().find(t => t.actionId === original.actionId)!.status).toBe("REVERSED");
      expect(f.transferRepository.list()).toHaveLength(2);
    });

    it("rechecks recipient capacity before resuming an interrupted reversal", () => {
      const f = fixture(); const original = createTransfer(transferCommand(), f.deps);
      f.transferRepository.append({
        ...original, actionId: "reversal-1", fromCategory: original.toCategory, toCategory: original.fromCategory,
        reason: `Reversal of ${original.actionId}`, status: "REVERSED", reversalReference: original.actionId,
      });
      f.expenses.getRange("B2:F2").setValues([[new Date("2026-09-23T00:00:00+07:00"), "Shopping", "Shoes", "Main Account", 599999]]);
      f.flush();

      expect(() => reverseTransfer({ actionId: "reversal-1", transferId: original.actionId }, f.deps))
        .toThrow("RECIPIENT_BUDGET_EXCEEDED");
      expect(f.transferRepository.list().find(t => t.actionId === original.actionId)!.status).toBe("ACTIVE");
    });

    it("rejects a reversal that would make the recipient negative", () => {
      const f = fixture(); const original = createTransfer(transferCommand(), f.deps);
      f.expenses.getRange("B2:F2").setValues([[new Date("2026-09-23T00:00:00+07:00"), "Shopping", "Shoes", "Main Account", 599999]]);
      f.flush();
      expect(() => reverseTransfer({ actionId: "reversal-1", transferId: original.actionId }, f.deps)).toThrow("RECIPIENT_BUDGET_EXCEEDED");
      expect(f.transferRepository.list()).toHaveLength(1);
      expect(f.transferRepository.list()[0].status).toBe("ACTIVE");
    });

    it("allows a reversal exactly at the recipient's remaining availability", () => {
      const f = fixture(); const original = createTransfer(transferCommand(), f.deps);
      f.expenses.getRange("B2:F2").setValues([[new Date("2026-09-23T00:00:00+07:00"), "Shopping", "Shoes", "Main Account", 400000]]);
      f.flush();
      expect(() => reverseTransfer({ actionId: "reversal-1", transferId: original.actionId }, f.deps)).not.toThrow();
    });

    it("rejects reversing an unknown transfer", () => {
      const f = fixture();
      expect(() => reverseTransfer({ actionId: "reversal-1", transferId: "missing" }, f.deps)).toThrow("INVALID_INPUT");
    });

    it("rejects reversing an already-reversed transfer", () => {
      const f = fixture(); const original = createTransfer(transferCommand(), f.deps);
      reverseTransfer({ actionId: "reversal-1", transferId: original.actionId }, f.deps);
      expect(() => reverseTransfer({ actionId: "reversal-2", transferId: original.actionId }, f.deps)).toThrow("INVALID_INPUT");
    });

    it("rejects reversing a transfer outside the currently open month", () => {
      const f = fixture(); const original = createTransfer(transferCommand(), f.deps);
      f.deps.clock = jakartaClock(new Date("2026-10-05T00:00:00Z"));
      expect(() => reverseTransfer({ actionId: "reversal-1", transferId: original.actionId }, f.deps)).toThrow("INVALID_INPUT");
    });
  });
});

describe("income service using the authorized workbook", () => {
  it("records a confirmed expected-income entry", () => {
    const f = fixture(); const income = createExpectedIncome(incomeCommand(), f.deps);
    expect(income.status).toBe("CONFIRMED");
    const row = f.income.getRange("A2:I2").getValues()[0];
    expect(row[0]).toBe("income-1"); expect(row[7]).toBe("CONFIRMED");
    expect(f.summary.getRange("K2").getValue()).toBe(500000);
  });

  it("returns the same durable row on duplicate action IDs", () => {
    const f = fixture(); const first = createExpectedIncome(incomeCommand(), f.deps);
    expect(createExpectedIncome(incomeCommand({ amount: 1 }), f.deps)).toEqual(first);
    expect(f.incomeRepository.list()).toHaveLength(1);
  });

  it("rejects an unknown destination account", () => {
    const f = fixture();
    expect(() => createExpectedIncome(incomeCommand({ destinationAccount: "Unknown" }), f.deps)).toThrow("INVALID_INPUT");
    expect(f.incomeRepository.list()).toEqual([]);
  });

  it("marks a confirmed entry received and stops counting it toward the forecast", () => {
    const f = fixture(); createExpectedIncome(incomeCommand(), f.deps);
    expect(f.summary.getRange("K2").getValue()).toBe(500000);
    const received = markIncomeReceived({ actionId: "income-1" }, f.deps);
    expect(received.status).toBe("RECEIVED");
    expect(f.summary.getRange("K2").getValue()).toBe(0);
  });

  it("is idempotent when marking an already-received entry received again", () => {
    const f = fixture(); createExpectedIncome(incomeCommand(), f.deps);
    const first = markIncomeReceived({ actionId: "income-1" }, f.deps);
    expect(markIncomeReceived({ actionId: "income-1" }, f.deps)).toEqual(first);
  });

  it("cancels a confirmed entry and stops counting it toward the forecast", () => {
    const f = fixture(); createExpectedIncome(incomeCommand(), f.deps);
    const cancelled = cancelExpectedIncome({ actionId: "income-1" }, f.deps);
    expect(cancelled.status).toBe("CANCELLED");
    expect(f.summary.getRange("K2").getValue()).toBe(0);
  });

  it("rejects cancelling an already-received entry", () => {
    const f = fixture(); createExpectedIncome(incomeCommand(), f.deps);
    markIncomeReceived({ actionId: "income-1" }, f.deps);
    expect(() => cancelExpectedIncome({ actionId: "income-1" }, f.deps)).toThrow("INVALID_INPUT");
  });

  it("rejects transitioning an unknown action ID", () => {
    const f = fixture();
    expect(() => markIncomeReceived({ actionId: "missing" }, f.deps)).toThrow("INVALID_INPUT");
  });

  it("fails closed on a corrupt repository status cell", () => {
    const f = fixture(); createExpectedIncome(incomeCommand(), f.deps); f.income.getRange("H2").setValue("UNKNOWN");
    expect(() => createExpectedIncome(incomeCommand({ actionId: "income-2" }), f.deps)).toThrow("WORKBOOK_SCHEMA_INVALID");
  });
});
