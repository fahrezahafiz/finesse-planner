import { afterEach, describe, expect, it, vi } from "vitest";
import { createEndpoints } from "../../src/server/endpoints";
import type { ServerDeps } from "../../src/server/deps";
import { setupPlanningSheets } from "../../src/server/workbook/setup";
import { PlanRepository } from "../../src/server/workbook/plan-repository";
import { TransferRepository } from "../../src/server/workbook/transfer-repository";
import { IncomeRepository } from "../../src/server/workbook/income-repository";
import { jakartaClock } from "../../src/domain/time";
import { planningWorkbook } from "../helpers/planning-workbook";
import { fakeDeps, installFakeSheetsApi } from "../helpers/fake-apps-script";
import { validProposal } from "../helpers/domain-fixtures";

function fixture(now = new Date("2026-09-23T00:00:00Z")) {
  const f = planningWorkbook();
  setupPlanningSheets(f.auth, f.map);
  // authorizeCaller() requires a getName() probe; the fixture workbook does not model it.
  (f.workbook as unknown as { getName: () => string }).getName = () => "Household planner";

  const baselines: Record<string, number> = { Dining: 600000, Shopping: 400000 };
  f.sheets.get("Atur Budgeting")!.getRange("D2:E3").setValues([["Dining", 600000], ["Shopping", 400000]]);
  f.sheets.get("Catat - Pendapatan")!.getRange("F2").setValue(3000000);
  f.sheets.get("backend")!.getRange("C2").setValue(3000000);

  const ledger = f.sheets.get("Rencana Pengeluaran")!;
  const transfers = f.sheets.get("Transfer Budget")!;
  const income = f.sheets.get("Pendapatan Diharapkan")!;
  const summary = f.sheets.get("Ringkasan Perencanaan")!;
  const expenses = f.sheets.get("Catat - Pengeluaran")!;

  let currentNow = now;
  let held = false;
  let onAcquire = () => {};
  const lock = {
    tryLock: (_ms: number) => { if (held) return false; held = true; onAcquire(); return true; },
    releaseLock: () => { held = false; },
  };

  // Simulates only the external Sheets recalculation boundary (SpreadsheetApp.flush()); every
  // endpoint, service, repository, and domain rule involved runs as production code. Reads the
  // clock fresh every call (like the plan/transfer/income service fixtures read deps.clock) so a
  // test can move `currentNow` into a new month and still get a consistent recomputed summary.
  function flush() {
    const clock = jakartaClock(currentNow);
    const month = clock.month, today = clock.today, monthEnd = clock.monthEnd;
    const categoryNames = Object.keys(baselines);
    const transferRows = transfers.getRange("A2:K1001").getValues().filter((r: any[]) => r[0] !== "");
    const netFor = (name: string, column: 4 | 5) => transferRows
      .filter((r: any[]) => r[3] === month && r[9] === "ACTIVE" && r[column] === name)
      .reduce((sum: number, r: any[]) => sum + r[6], 0);
    const expenseRows = expenses.getRange("A2:F1001").getValues().filter((r: any[]) => r[1] !== "");
    const spentFor = (name: string) => expenseRows
      .filter((r: any[]) => r[2] === name && jakartaClock(r[1]).month === month)
      .reduce((sum: number, r: any[]) => sum + r[5], 0);
    const planRows = ledger.getRange("A2:U1001").getValues().filter((r: any[]) => r[0] !== "");
    const reservedFor = (name: string) => planRows
      .filter((r: any[]) => r[3] === month && ["RESERVED", "OVERRIDDEN"].includes(r[9]) && r[6] === name)
      .reduce((sum: number, r: any[]) => sum + r[8], 0);

    const rows = categoryNames.map(name => {
      const baseline = baselines[name]!;
      const transfersIn = netFor(name, 5), transfersOut = netFor(name, 4);
      const adjusted = baseline + transfersIn - transfersOut;
      const spent = spentFor(name);
      const reserved = reservedFor(name);
      return [name, baseline, transfersIn, transfersOut, adjusted, spent, reserved, adjusted - spent - reserved];
    });
    summary.getRange(`A2:H${1 + rows.length}`).setValues(rows);

    const totalBaseline = Object.values(baselines).reduce((sum, value) => sum + value, 0);
    const totalAdjusted = rows.reduce((sum, row) => sum + (row[4] as number), 0);
    const incomeRows = income.getRange("A2:I1001").getValues().filter((r: any[]) => r[0] !== "");
    const futureIncome = incomeRows
      .filter((r: any[]) => r[7] === "CONFIRMED" && jakartaClock(r[3]).today >= today && jakartaClock(r[3]).today <= monthEnd)
      .reduce((sum: number, r: any[]) => sum + r[6], 0);
    const actualIncome = 3000000, savings = 200000;
    const recognized = actualIncome + futureIncome;
    const headroom = recognized - savings - totalAdjusted;
    const reconciliation = rows.reduce((sum, row) => sum + (row[2] as number), 0) - rows.reduce((sum, row) => sum + (row[3] as number), 0);
    summary.getRange("K1:K12").setValues([
      [actualIncome], [futureIncome], [recognized], [savings], [totalBaseline], [totalAdjusted],
      [headroom], [headroom], ["HEALTHY"], [reconciliation], [month], [today],
    ]);
  }
  flush();

  const base = fakeDeps({ now });
  const deps: ServerDeps = { ...base, spreadsheetApp: { openById: () => f.workbook }, sourceMap: f.map, lock, now: () => currentNow };
  vi.stubGlobal("SpreadsheetApp", { flush });
  const sheetsById = () => new Map([...f.sheets.values()].map(sheet => [sheet.getSheetId(), sheet]));
  installFakeSheetsApi(f.workbook.getId(), sheetsById, flush);

  return {
    ...f, ledger, transfers, income, summary, expenses, deps, flush,
    audit: base.audit,
    endpoints: createEndpoints({ deps }),
    planRepository: new PlanRepository(f.auth),
    transferRepository: new TransferRepository(f.auth),
    incomeRepository: new IncomeRepository(f.auth),
    held: () => held,
    onAcquire: (fn: () => void) => { onAcquire = fn; },
    advanceTo: (nextNow: Date) => { currentNow = nextNow; },
  };
}

function planCommand(overrides: Record<string, unknown> = {}) {
  return { actionId: "plan-1", item: "Headphones", amount: 300000, category: "Dining", plannedDate: "2026-09-24", paymentAccount: "Main Account", ...overrides };
}
function transferCommand(overrides: Record<string, unknown> = {}) {
  return { actionId: "transfer-1", fromCategory: "Dining", toCategory: "Shopping", amount: 100000, reason: "Cover shopping overage", ...overrides };
}
function incomeCommand(overrides: Record<string, unknown> = {}) {
  return { actionId: "income-1", expectedDate: "2026-09-25", source: "Freelance", destinationAccount: "Main Account", amount: 500000, ...overrides };
}
function unwrap<T>(result: { ok: boolean; data?: T; error?: unknown }): T {
  if (!result.ok) throw new Error(`expected ok:true, got ${JSON.stringify(result)}`);
  return result.data as T;
}

afterEach(() => vi.unstubAllGlobals());

describe("secured planner endpoints: data minimization", () => {
  it("does not expose sheet names, ranges, formulas, or raw rows from getBootstrap", () => {
    const f = fixture();
    const response = f.endpoints.getBootstrap(undefined);
    expect(JSON.stringify(response)).not.toMatch(/sheetId|range|formula|backend|rawRows/);
  });

  it("does not expose sheet names, ranges, formulas, or raw rows from any mutation or read endpoint", () => {
    const f = fixture();
    const responses = [
      f.endpoints.checkPurchaseRpc(validProposal({ category: "Shopping", amount: 100000 as never })),
      f.endpoints.reservePurchaseRpc(planCommand()),
      f.endpoints.overridePurchaseRpc(planCommand({ actionId: "plan-2", amount: 1200000, reason: "Necessary" })),
      f.endpoints.cancelPlanRpc({ actionId: "plan-1" }),
      f.endpoints.createTransferRpc(transferCommand()),
      f.endpoints.reverseTransferRpc({ actionId: "reversal-1", transferId: "transfer-1" }),
      f.endpoints.createExpectedIncomeRpc(incomeCommand()),
      f.endpoints.updateExpectedIncomeRpc({ actionId: "income-1", status: "RECEIVED" }),
      f.endpoints.getHistoryRpc(undefined),
      f.endpoints.getInsightsRpc(undefined),
      f.endpoints.applyBaselineReviewRpc({
        actionId: "review-1",
        reason: "Shopping consistently overspends; Dining consistently has headroom.",
        changes: [
          { category: "Dining", expectedAmount: 600000, newAmount: 500000 },
          { category: "Shopping", expectedAmount: 400000, newAmount: 500000 },
        ],
      }),
    ];
    for (const response of responses) {
      expect(JSON.stringify(response)).not.toMatch(/sheetId|range|formula|backend|rawRows/);
    }
  });
});

describe("secured planner endpoints: authorization", () => {
  it("rechecks authorization on every endpoint call", () => {
    const f = fixture();
    f.endpoints.getBootstrap(undefined);
    f.endpoints.checkPurchaseRpc(validProposal());
    expect(f.audit.authorizationChecks).toBe(2);
  });

  it("denies access and never calls a service when the workbook cannot be opened", () => {
    const f = fixture();
    f.deps.spreadsheetApp = { openById: () => { throw new Error("Permission denied for book-id"); } };
    const result = f.endpoints.reservePurchaseRpc(planCommand());
    expect(result).toEqual({ ok: false, error: { code: "ACCESS_DENIED", message: "Access to this planner is denied." } });
    expect(f.planRepository.list()).toEqual([]);
    expect(f.held()).toBe(false);
  });
});

describe("secured planner endpoints: validation", () => {
  it("rejects malformed input before touching the lock or the ledger", () => {
    const f = fixture();
    const result = f.endpoints.reservePurchaseRpc(planCommand({ amount: "not a number" }));
    expect(result).toMatchObject({ ok: false, error: { code: "INVALID_AMOUNT" } });
    expect(f.planRepository.list()).toEqual([]);
    expect(f.held()).toBe(false);
  });

  it("requires an override reason", () => {
    const f = fixture();
    const result = f.endpoints.overridePurchaseRpc(planCommand({ reason: "  " }));
    expect(result).toMatchObject({ ok: false, error: { code: "OVERRIDE_REASON_REQUIRED" } });
    expect(f.planRepository.list()).toEqual([]);
  });

  it("rejects an unknown update-income status", () => {
    const f = fixture();
    unwrap(f.endpoints.createExpectedIncomeRpc(incomeCommand()));
    const result = f.endpoints.updateExpectedIncomeRpc({ actionId: "income-1", status: "APPROVED" });
    expect(result).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
  });
});

describe("getBootstrap", () => {
  it("shows protected savings, funded amount, safe-to-plan amount, days remaining, and active reservations", () => {
    const f = fixture();
    unwrap(f.endpoints.reservePurchaseRpc(planCommand()));
    const state = unwrap(f.endpoints.getBootstrap(undefined));
    expect(state).toMatchObject({
      month: "2026-09",
      health: "HEALTHY",
      protectedSavings: 200000,
      fundedAmount: 3000000,
      daysRemaining: 8,
    });
    expect(state.safeToPlanAmount).toBeTypeOf("number");
    expect(state.activeReservations).toEqual([{ amount: 300000, paymentAccount: "Main Account", plannedDate: "2026-09-24" }]);
    expect(state.categories).toEqual(expect.arrayContaining([{ category: "Dining", adjustedBudget: 600000, availableBudget: 300000 }]));
  });

  it("rolls over stale reservations before showing state", () => {
    const f = fixture();
    unwrap(f.endpoints.reservePurchaseRpc(planCommand()));
    // Jakarta local time for this instant is 2026-10-01T00:00, the first moment of a new month.
    f.advanceTo(new Date("2026-09-30T17:00:00Z"));
    f.sheets.get("backend")!.getRange("G2").setValue("2026-10-01");
    f.sheets.get("Catat - Pendapatan")!.getRange("B2").setValue(new Date("2026-10-01T00:00:00+07:00"));
    const state = unwrap(f.endpoints.getBootstrap(undefined));
    expect(f.planRepository.list().map(plan => plan.status)).toEqual(["EXPIRED"]);
    expect(state.month).toBe("2026-10");
    expect(state.activeReservations).toEqual([]);
  });
});

describe("checkPurchaseRpc", () => {
  it("returns a decision and corrections without creating a reservation", () => {
    const f = fixture();
    const response = unwrap(f.endpoints.checkPurchaseRpc(planCommand({ amount: 900000 })));
    expect(response.decision.verdict).toBe("NOT_RECOMMENDED");
    expect(response.corrections.length).toBeGreaterThan(0);
    expect(f.planRepository.list()).toEqual([]);
  });

  it("recommends an affordable purchase with no corrections needed", () => {
    const f = fixture();
    const response = unwrap(f.endpoints.checkPurchaseRpc(planCommand({ amount: 100000 })));
    expect(response.decision.verdict).toBe("RECOMMENDED");
    expect(response.corrections).toEqual([]);
  });
});

describe("reservePurchaseRpc / overridePurchaseRpc / cancelPlanRpc", () => {
  it("reserves a purchase and returns actionId plus refreshed planning state", () => {
    const f = fixture();
    const response = unwrap(f.endpoints.reservePurchaseRpc(planCommand()));
    expect(response.actionId).toBe("plan-1");
    expect(response.result).toMatchObject({ actionId: "plan-1", status: "RESERVED", amount: 300000, category: "Dining" });
    expect(response.planningState.categories).toEqual(expect.arrayContaining([{ category: "Dining", adjustedBudget: 600000, availableBudget: 300000 }]));
    expect(f.held()).toBe(false);
  });

  it("overrides a purchase that failed a guardrail, given a reason", () => {
    const f = fixture();
    const response = unwrap(f.endpoints.overridePurchaseRpc(planCommand({ amount: 900000, reason: "Necessary replacement" })));
    expect(response.result).toMatchObject({ status: "OVERRIDDEN", overrideReason: "Necessary replacement" });
  });

  it("cancels a reservation and releases its budget in the refreshed state", () => {
    const f = fixture();
    unwrap(f.endpoints.reservePurchaseRpc(planCommand()));
    const response = unwrap(f.endpoints.cancelPlanRpc({ actionId: "plan-1" }));
    expect(response.result).toMatchObject({ status: "CANCELLED" });
    expect(response.planningState.categories).toEqual(expect.arrayContaining([{ category: "Dining", adjustedBudget: 600000, availableBudget: 600000 }]));
  });
});

describe("completePlanRpc", () => {
  it("completes a reservation and records the actual expense", () => {
    const f = fixture();
    unwrap(f.endpoints.reservePurchaseRpc(planCommand()));
    const response = unwrap(f.endpoints.completePlanRpc({ actionId: "plan-1" }));
    expect(response.result).toMatchObject({ status: "COMPLETED" });
    const row = f.expenses.getRange("B2:F2").getValues()[0];
    expect(jakartaClock(row[0]).today).toBe("2026-09-23");
    expect(row.slice(1)).toEqual(["Dining", "Headphones", "Main Account", 300000]);
  });
});

describe("createTransferRpc / reverseTransferRpc", () => {
  it("moves budget between categories and reports it in the refreshed state", () => {
    const f = fixture();
    const response = unwrap(f.endpoints.createTransferRpc(transferCommand()));
    expect(response.result).toMatchObject({ status: "ACTIVE", fromCategory: "Dining", toCategory: "Shopping" });
    expect(response.planningState.categories).toEqual(expect.arrayContaining([
      { category: "Dining", adjustedBudget: 500000, availableBudget: 500000 },
      { category: "Shopping", adjustedBudget: 500000, availableBudget: 500000 },
    ]));
  });

  it("reverses a transfer within the same month", () => {
    const f = fixture();
    unwrap(f.endpoints.createTransferRpc(transferCommand()));
    const response = unwrap(f.endpoints.reverseTransferRpc({ actionId: "reversal-1", transferId: "transfer-1" }));
    expect(response.result).toMatchObject({ status: "REVERSED", reversalReference: "transfer-1" });
    expect(response.planningState.categories).toEqual(expect.arrayContaining([
      { category: "Dining", adjustedBudget: 600000, availableBudget: 600000 },
      { category: "Shopping", adjustedBudget: 400000, availableBudget: 400000 },
    ]));
  });
});

describe("createExpectedIncomeRpc / updateExpectedIncomeRpc", () => {
  it("creates an expected income entry", () => {
    const f = fixture();
    const response = unwrap(f.endpoints.createExpectedIncomeRpc(incomeCommand()));
    expect(response.result).toMatchObject({ status: "CONFIRMED", source: "Freelance", amount: 500000 });
  });

  it("marks an expected income received when status is RECEIVED", () => {
    const f = fixture();
    unwrap(f.endpoints.createExpectedIncomeRpc(incomeCommand()));
    const response = unwrap(f.endpoints.updateExpectedIncomeRpc({ actionId: "income-1", status: "RECEIVED" }));
    expect(response.result).toMatchObject({ status: "RECEIVED" });
  });

  it("cancels an expected income when status is CANCELLED", () => {
    const f = fixture();
    unwrap(f.endpoints.createExpectedIncomeRpc(incomeCommand()));
    const response = unwrap(f.endpoints.updateExpectedIncomeRpc({ actionId: "income-1", status: "CANCELLED" }));
    expect(response.result).toMatchObject({ status: "CANCELLED" });
  });
});

describe("getHistoryRpc", () => {
  it("shows completed/cancelled/expired plans, reversed transfers, and received/cancelled income, excluding active rows", () => {
    const f = fixture();
    unwrap(f.endpoints.reservePurchaseRpc(planCommand({ actionId: "plan-cancelled" })));
    unwrap(f.endpoints.cancelPlanRpc({ actionId: "plan-cancelled" }));
    unwrap(f.endpoints.reservePurchaseRpc(planCommand({ actionId: "plan-completed" })));
    unwrap(f.endpoints.completePlanRpc({ actionId: "plan-completed" }));
    unwrap(f.endpoints.reservePurchaseRpc(planCommand({ actionId: "plan-active" })));
    // Dining's headroom is exhausted by the three reservations above; donate from Shopping instead.
    unwrap(f.endpoints.createTransferRpc(transferCommand({ fromCategory: "Shopping", toCategory: "Dining", amount: 50000 })));
    unwrap(f.endpoints.reverseTransferRpc({ actionId: "reversal-1", transferId: "transfer-1" }));
    unwrap(f.endpoints.createExpectedIncomeRpc(incomeCommand({ actionId: "income-received" })));
    unwrap(f.endpoints.updateExpectedIncomeRpc({ actionId: "income-received", status: "RECEIVED" }));
    unwrap(f.endpoints.createExpectedIncomeRpc(incomeCommand({ actionId: "income-active" })));

    const history = unwrap(f.endpoints.getHistoryRpc(undefined));

    expect(history.plans.map(plan => plan.actionId).sort()).toEqual(["plan-cancelled", "plan-completed"]);
    expect(history.plans.every(plan => ["COMPLETED", "CANCELLED", "EXPIRED"].includes(plan.status))).toBe(true);
    expect(history.transfers.map(transfer => transfer.actionId).sort()).toEqual(["reversal-1", "transfer-1"]);
    expect(history.transfers.every(transfer => transfer.status === "REVERSED")).toBe(true);
    expect(history.income.map(entry => entry.actionId)).toEqual(["income-received"]);
  });
});

describe("getInsightsRpc", () => {
  it("bundles transfer-pattern insights and a baseline-review proposal in one response", () => {
    const f = fixture();
    const response = unwrap(f.endpoints.getInsightsRpc(undefined));
    expect(response.transferPatterns.windowMonths).toHaveLength(6);
    expect(response.baselineReview.windowMonths).toHaveLength(6);
    expect(response.baselineReview.changes).toEqual([]);
  });
});

describe("applyBaselineReviewRpc", () => {
  it("applies a reviewed zero-sum baseline change and returns refreshed state", () => {
    const f = fixture();
    const response = unwrap(f.endpoints.applyBaselineReviewRpc({
      actionId: "review-1",
      reason: "Shopping consistently overspends; Dining consistently has headroom.",
      changes: [
        { category: "Dining", expectedAmount: 600000, newAmount: 500000 },
        { category: "Shopping", expectedAmount: 400000, newAmount: 500000 },
      ],
    }));
    expect(response.actionId).toBe("review-1");
    expect(response.result.changes).toEqual(expect.arrayContaining([
      { category: "Dining", previousAmount: 600000, newAmount: 500000 },
      { category: "Shopping", previousAmount: 400000, newAmount: 500000 },
    ]));
    expect(f.sheets.get("Atur Budgeting")!.getRange("E2:E3").getValues()).toEqual([[500000], [500000]]);
  });
});
