import { vi } from "vitest";
import { jakartaClock } from "../../src/domain/time";
import { createEndpoints } from "../../src/server/endpoints";
import type { ServerDeps } from "../../src/server/deps";
import { setupPlanningSheets } from "../../src/server/workbook/setup";
import { PlanRepository } from "../../src/server/workbook/plan-repository";
import { TransferRepository } from "../../src/server/workbook/transfer-repository";
import { IncomeRepository } from "../../src/server/workbook/income-repository";
import { planningWorkbook } from "./planning-workbook";
import { fakeDeps, installFakeSheetsApi } from "./fake-apps-script";

export interface EndpointFixtureOptions {
  now?: Date;
  /** category name -> baseline budget. Defaults to the same Dining/Shopping pair used across Task 11's endpoint tests. */
  baselines?: Record<string, number>;
  actualIncome?: number;
  /** "backend" account balance for the single "Main Account" the fixture workbook seeds. */
  accountBalance?: number;
  protectedSavings?: number;
}

/**
 * Builds the same kind of authorized-workbook + secured-endpoint fixture Task 11's
 * test/integration/endpoints.test.ts uses, generalized so acceptance/concurrency/security tests can
 * vary the baseline budgets, funded income, account balance, and protected-savings target that drive
 * the scenario under test. Every read/write still goes through the real endpoints -> services ->
 * repositories -> domain modules; only the external Sheets recalculation boundary (SpreadsheetApp.flush())
 * is simulated, exactly as in every other Task 5-13 integration fixture.
 */
export function endpointFixture(options: EndpointFixtureOptions = {}) {
  const now = options.now ?? new Date("2026-09-23T00:00:00Z");
  const baselines = options.baselines ?? { Dining: 600000, Shopping: 400000 };
  const actualIncome = options.actualIncome ?? 3000000;
  const accountBalance = options.accountBalance ?? 3000000;
  const protectedSavings = options.protectedSavings ?? 200000;

  const f = planningWorkbook();
  setupPlanningSheets(f.auth, f.map);
  // authorizeCaller() requires a getName() probe; the fixture workbook does not model it.
  (f.workbook as unknown as { getName: () => string }).getName = () => "Household planner";

  const categoryNames = Object.keys(baselines);
  const budgetRows = categoryNames.map(name => [name, baselines[name]]);
  f.sheets.get("Atur Budgeting")!.getRange(`D2:E${1 + budgetRows.length}`).setValues(budgetRows);
  f.sheets.get("Catat - Pendapatan")!.getRange("F2").setValue(actualIncome);
  f.sheets.get("backend")!.getRange("C2").setValue(accountBalance);
  f.sheets.get("Profil Kemampuan Menabung")!.getRange("D2").setValue(protectedSavings);
  // planningWorkbook()'s defaults (freshness "2026-09-23", income date "2026-09-01") assume the
  // default `now`; align formula freshness with whatever `now` this fixture actually uses so a
  // custom `now` (e.g. near a Jakarta month/midnight boundary) does not spuriously read as stale.
  f.sheets.get("backend")!.getRange("G2").setValue(jakartaClock(now).today);
  f.sheets.get("Catat - Pendapatan")!.getRange("B2").setValue(new Date(`${jakartaClock(now).today}T00:00:00+07:00`));

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
  // endpoint, service, repository, and domain rule involved runs as production code.
  function flush() {
    const clock = jakartaClock(currentNow);
    const month = clock.month, today = clock.today, monthEnd = clock.monthEnd;
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
    const recognized = actualIncome + futureIncome;
    const headroom = recognized - protectedSavings - totalAdjusted;
    const reconciliation = rows.reduce((sum, row) => sum + (row[2] as number), 0) - rows.reduce((sum, row) => sum + (row[3] as number), 0);
    summary.getRange("K1:K12").setValues([
      [actualIncome], [futureIncome], [recognized], [protectedSavings], [totalBaseline], [totalAdjusted],
      [headroom], [headroom], ["HEALTHY"], [reconciliation], [month], [today],
    ]);
  }
  flush();

  const base = fakeDeps({ now });
  const deps: ServerDeps = { ...base, spreadsheetApp: { openById: () => f.workbook }, sourceMap: f.map, lock, now: () => currentNow };
  vi.stubGlobal("SpreadsheetApp", { flush });
  const sheetsById = () => new Map([...f.sheets.values()].map(sheet => [sheet.getSheetId(), sheet]));
  const sheetsController = installFakeSheetsApi(f.workbook.getId(), sheetsById, flush);

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
    sheetsController,
  };
}

export function planCommand(overrides: Record<string, unknown> = {}) {
  return { actionId: "plan-1", item: "Headphones", amount: 300000, category: "Dining", plannedDate: "2026-09-24", paymentAccount: "Main Account", ...overrides };
}
export function transferCommand(overrides: Record<string, unknown> = {}) {
  return { actionId: "transfer-1", fromCategory: "Dining", toCategory: "Shopping", amount: 100000, reason: "Cover shopping overage", ...overrides };
}
export function incomeCommand(overrides: Record<string, unknown> = {}) {
  return { actionId: "income-1", expectedDate: "2026-09-25", source: "Freelance", destinationAccount: "Main Account", amount: 500000, ...overrides };
}
export function unwrap<T>(result: { ok: boolean; data?: T; error?: unknown }): T {
  if (!result.ok) throw new Error(`expected ok:true, got ${JSON.stringify(result)}`);
  return result.data as T;
}
