import type { AuthContext } from "../auth";
import type { RequestClock } from "../../domain/time";
import { jakartaClock } from "../../domain/time";
import type { LocalDate, Money, PlanningHealth, PlanningSnapshot, CategoryPlanningSnapshot, AccountPlanningSnapshot, ActiveReservationSnapshot, ConfirmedIncomeSnapshot } from "../../domain/types";
import { parseLocalDate, parseMoney, parseYearMonth } from "../../domain/validation";
import { validateWorkbookSchema } from "./schema";
import type { SourceRange, WorkbookSourceMap } from "./source-map";
import { assertPlanningHeaders } from "./setup";
import { aggregateBaseline, buildSummaryFormulas, planningMath, sourceNamedRanges, SUMMARY_NAMED_RANGES } from "./formulas";

/** Reads the workbook already opened under the caller's authority. No opener or global workbook is used. */
export function readPlanningSnapshot(auth: AuthContext, clock: RequestClock, sourceMap?: WorkbookSourceMap): PlanningSnapshot {
  let map: WorkbookSourceMap;
  try {
    map = validateWorkbookSchema(auth.workbook, sourceMap).sourceMap;
    if (map.timeZone !== "Asia/Jakarta") throw new Error();
    assertPlanningHeaders(auth.workbook);
    assertNamedRanges(auth.workbook, map);
  } catch { return invalidSnapshot(clock, "WORKBOOK_SCHEMA_INVALID"); }

  try {
    const sheet = auth.workbook.getSheetByName("Ringkasan Perencanaan")!;
    const formulas = buildSummaryFormulas();
    if (sheet.getRange("A2").getFormula() !== formulas.categoryNames
      || !sameMatrix(sheet.getRange("B2:H1001").getFormulas(), formulas.categories)
      || !sameMatrix(sheet.getRange("K1:K12").getFormulas(), formulas.household)) throw new Error();
    const household = sheet.getRange("K1:K12").getValues().map(row => row[0]);
    // Validate every required numeric output before any arithmetic or health decision.
    const numbers = [0, 1, 2, 3, 4, 5, 6, 7, 9].map(index => integer(household[index]));
    const [actualIncome, futureIncome, recognized, savings, baselineTotal, adjustedTotal, headroom, funding, reconciliation] = numbers;
    for (const value of [actualIncome, futureIncome, recognized, savings, baselineTotal, adjustedTotal]) parseMoney(value);
    if (parseYearMonth(household[10]) !== clock.month || parseLocalDate(household[11]) !== clock.today) return invalidSnapshot(clock, "STALE_PLANNING_MONTH");
    if (reconciliation !== 0) return invalidSnapshot(clock, "TRANSFER_RECONCILIATION_ERROR");
    if (headroom < 0) return invalidSnapshot(clock, "UNDERFUNDED");
    if (household[8] !== "HEALTHY") throw new Error();

    const source = readSources(auth.workbook, map, clock);
    if (source.freshness !== clock.today) return invalidSnapshot(clock, "STALE_PLANNING_MONTH");
    const categories: Record<string, CategoryPlanningSnapshot> = Object.create(null);
    const rows = sheet.getRange("A2:H1001").getValues();
    for (const [name, ...values] of rows) {
      if (name === "" && values.every(value => value === "")) continue;
      if (typeof name !== "string" || !Object.hasOwnProperty.call(source.categories, name) || Object.hasOwnProperty.call(categories, name)) throw new Error();
      const [baselineBudget, transfersIn, transfersOut, adjustedBudget, actualSpending, activeReservations, availableBudget] = values.map(integer);
      const category = {
        baselineBudget: parseMoney(baselineBudget), transfersIn: parseMoney(transfersIn), transfersOut: parseMoney(transfersOut),
        adjustedBudget: parseMoney(adjustedBudget), actualSpending: parseMoney(actualSpending), activeReservations: parseMoney(activeReservations), availableBudget,
      };
      const expected = source.categories[name];
      if (!Object.keys(category).every(key => category[key as keyof typeof category] === expected[key as keyof typeof category])) throw new Error();
      categories[name] = category;
    }
    if (Object.keys(categories).length !== Object.keys(source.categories).length) throw new Error();
    const categoryValues = Object.values(categories);
    const expectedAdjusted = categoryValues.reduce((sum, category) => sum + category.adjustedBudget, 0);
    const expectedBaseline = categoryValues.reduce((sum, category) => sum + category.baselineBudget, 0);
    if (actualIncome !== source.actualIncome || futureIncome !== source.futureIncome || savings !== source.savings
      || recognized !== actualIncome + futureIncome || baselineTotal !== expectedBaseline || adjustedTotal !== expectedAdjusted
      || headroom !== planningMath.headroom(planningMath.spendablePool(actualIncome, futureIncome, savings), adjustedTotal)
      || funding !== headroom) throw new Error();
    return {
      month: clock.month, health: "HEALTHY", actualIncome: parseMoney(actualIncome), confirmedFutureIncome: parseMoney(futureIncome),
      protectedSavingsTarget: parseMoney(savings), totalAdjustedBudgets: parseMoney(adjustedTotal), unallocatedHeadroom: headroom,
      categories, accounts: source.accounts, planningDate: clock.today, daysRemainingInclusive: clock.daysRemainingInclusive,
      confirmedIncome: source.confirmedIncome, activeReservations: source.activeReservations,
    };
  } catch { return invalidSnapshot(clock, "FORMULA_ERROR"); }
}

function readSources(workbook: GoogleAppsScript.Spreadsheet.Spreadsheet, map: WorkbookSourceMap, clock: RequestClock) {
  const column = (range: SourceRange): unknown[] => workbook.getSheetByName(range.sheet)!.getRange(range.a1).getValues().map(row => row[0]);
  const scalar = (range: SourceRange): unknown => { const values = column(range); if (values.length !== 1) throw new Error(); return values[0]; };
  const pair = (left: SourceRange, right: SourceRange) => { const a = column(left); const b = column(right); if (a.length !== b.length) throw new Error(); return a.map((value, i) => [value, b[i]]); };
  const baseline = aggregateBaseline(pair(map.baseline.category, map.baseline.plannedAmount));
  const categories: Record<string, CategoryPlanningSnapshot> = Object.create(null);
  const activeReservations: ActiveReservationSnapshot[] = [];
  const confirmedIncome: ConfirmedIncomeSnapshot[] = [];
  for (const [name, amount] of Object.entries(baseline)) categories[name] = {
    baselineBudget: parseMoney(amount), transfersIn: parseMoney(0), transfersOut: parseMoney(0), adjustedBudget: parseMoney(amount),
    actualSpending: parseMoney(0), activeReservations: parseMoney(0), availableBudget: amount,
  };
  const accounts: Record<string, AccountPlanningSnapshot> = Object.create(null);
  for (const [name, balance] of pair(map.accounts.names, map.accounts.currentBalances)) {
    if (name === "" && balance === "") continue;
    if (typeof name !== "string" || !name.trim() || name.startsWith("#") || Object.hasOwnProperty.call(accounts, name)) throw new Error();
    accounts[name] = { currentBalance: parseMoney(balance) };
  }
  if (!Object.keys(accounts).length) throw new Error();
  const savings = parseMoney(scalar(map.savingsProfile.protectedMonthlySavings));
  parseMoney(scalar(map.savingsProfile.plannedIncome)); parseMoney(scalar(map.savingsProfile.plannedExpenses));
  let actualIncome = 0;
  for (const [date, amount] of pair(map.actualIncome.date, map.actualIncome.amount)) {
    if (date === "" && amount === "") continue;
    const day = sheetDate(date); const money = parseMoney(amount);
    if (day.slice(0, 7) === clock.month) actualIncome += money;
  }
  const expenseDates = column(map.expenseInput.date), expenseCategories = column(map.expenseInput.category), expenseAmounts = column(map.expenseInput.amount);
  for (let i = 0; i < expenseDates.length; i++) {
    if ([expenseDates[i], expenseCategories[i], expenseAmounts[i]].every(value => value === "")) continue;
    const day = sheetDate(expenseDates[i]); const money = parseMoney(expenseAmounts[i]);
    if (day.slice(0, 7) !== clock.month) continue;
    const category = categoryFor(categories, expenseCategories[i]); category.actualSpending = parseMoney(category.actualSpending + money);
  }
  for (const row of workbook.getSheetByName("Transfer Budget")!.getRange("A2:K1001").getValues()) {
    if (row.every(value => value === "")) continue;
    requireId(row[0]); const month = sheetMonth(row[3]); const amount = positiveMoney(row[6]);
    if (!["ACTIVE", "REVERSED"].includes(row[9])) throw new Error();
    if (month !== clock.month || row[9] !== "ACTIVE") continue;
    const from = categoryFor(categories, row[4]), to = categoryFor(categories, row[5]);
    if (from === to) throw new Error();
    from.transfersOut = parseMoney(from.transfersOut + amount); to.transfersIn = parseMoney(to.transfersIn + amount);
  }
  for (const row of workbook.getSheetByName("Rencana Pengeluaran")!.getRange("A2:U1001").getValues()) {
    if (row.every(value => value === "")) continue;
    requireId(row[0]); const month = sheetMonth(row[3]); const plannedDate = sheetDate(row[4]); const amount = positiveMoney(row[8]);
    if (!["RESERVED", "OVERRIDDEN", "COMPLETED", "CANCELLED", "EXPIRED"].includes(row[9])) throw new Error();
    if (month !== clock.month || !["RESERVED", "OVERRIDDEN"].includes(row[9])) continue;
    if (!Object.hasOwnProperty.call(accounts, row[7])) throw new Error();
    const category = categoryFor(categories, row[6]); category.activeReservations = parseMoney(category.activeReservations + amount);
    activeReservations.push({ amount, paymentAccount: row[7] as string, plannedDate });
  }
  let futureIncome = 0;
  for (const row of workbook.getSheetByName("Pendapatan Diharapkan")!.getRange("A2:I1001").getValues()) {
    if (row.every(value => value === "")) continue;
    requireId(row[0]); const date = sheetDate(row[3]); const amount = positiveMoney(row[6]);
    if (!["CONFIRMED", "RECEIVED", "CANCELLED"].includes(row[7])) throw new Error();
    if (row[7] === "CONFIRMED" && date >= clock.today && date <= clock.monthEnd) {
      if (!Object.hasOwnProperty.call(accounts, row[5])) throw new Error();
      futureIncome += amount;
      confirmedIncome.push({ amount, destinationAccount: row[5] as string, expectedDate: date });
    }
  }
  for (const category of Object.values(categories)) {
    category.adjustedBudget = parseMoney(planningMath.adjustedBudget(category.baselineBudget, category.transfersIn, category.transfersOut));
    category.availableBudget = integer(planningMath.availableBudget(category.adjustedBudget, category.actualSpending, category.activeReservations));
  }
  const freshness = scalar(map.formulaFreshness);
  return { categories, accounts, savings, actualIncome: parseMoney(actualIncome), futureIncome: parseMoney(futureIncome), confirmedIncome, activeReservations, freshness: freshness instanceof Date ? jakartaClock(freshness).today : parseLocalDate(freshness) };
}

function assertNamedRanges(workbook: GoogleAppsScript.Spreadsheet.Spreadsheet, map: WorkbookSourceMap): void {
  const expected = {
    ...sourceNamedRanges(map),
    ...Object.fromEntries(Object.entries(SUMMARY_NAMED_RANGES).map(([name, a1]) => [name, { sheet: "Ringkasan Perencanaan", a1 }])),
  };
  for (const [name, target] of Object.entries(expected)) {
    const range = workbook.getRangeByName(name);
    if (!range || range.getSheet().getName() !== target.sheet || range.getA1Notation() !== target.a1) throw new Error();
  }
}

function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error(); return value;
}
function positiveMoney(value: unknown): Money { const result = parseMoney(value); if (!result) throw new Error(); return result; }
function requireId(value: unknown): void { if (typeof value !== "string" || !value.trim() || value.startsWith("#")) throw new Error(); }
function categoryFor(categories: Record<string, CategoryPlanningSnapshot>, value: unknown): CategoryPlanningSnapshot {
  if (typeof value !== "string" || !Object.hasOwnProperty.call(categories, value)) throw new Error(); return categories[value];
}
function sheetDate(value: unknown): LocalDate {
  // Formula date comparisons require real Sheets dates, not ISO-looking text.
  if (!(value instanceof Date)) throw new Error(); return jakartaClock(value).today;
}
function sheetMonth(value: unknown): string { return parseYearMonth(value); }
function sameMatrix(left: readonly (readonly unknown[])[], right: readonly (readonly unknown[])[]): boolean {
  return left.length === right.length && left.every((row, i) => row.length === right[i].length && row.every((value, j) => value === right[i][j]));
}
function invalidSnapshot(clock: RequestClock, health: PlanningHealth): PlanningSnapshot {
  // Missing money is unknown, never a fabricated zero. Consumers must gate on health.
  return {
    month: clock.month, health, actualIncome: NaN as Money, confirmedFutureIncome: NaN as Money,
    protectedSavingsTarget: NaN as Money, totalAdjustedBudgets: NaN as Money, unallocatedHeadroom: NaN,
    categories: Object.create(null), accounts: Object.create(null), planningDate: clock.today,
    daysRemainingInclusive: clock.daysRemainingInclusive, confirmedIncome: [], activeReservations: [],
  };
}
