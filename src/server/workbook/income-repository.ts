import { DomainError } from "../../domain/errors";
import { allowedIncomeTransitions, type ExpectedIncome, type IncomeStatus } from "../../domain/expected-income";
import { parseActionId, parseText } from "../../domain/plans";
import { jakartaClock } from "../../domain/time";
import { parseMoney } from "../../domain/validation";
import type { AuthContext } from "../auth";
import { EXPECTED_INCOME_HEADERS, LAST_PLANNING_ROW } from "./headers";
import { assertPlanningHeaders } from "./setup";

/** All reads and writes use the workbook already opened under the caller's authority. */
export class IncomeRepository {
  constructor(private readonly auth: AuthContext) {}

  list(): ExpectedIncome[] { return this.entries().map(entry => entry.income); }

  append(income: ExpectedIncome): void {
    const entries = this.entries();
    if (entries.some(entry => entry.income.actionId === income.actionId)) invalid();
    const lastRow = Math.max(1, ...entries.map(entry => entry.row));
    if (lastRow >= LAST_PLANNING_ROW) invalid();
    this.write(lastRow + 1, income);
  }

  update(income: ExpectedIncome): void {
    const entry = this.entries().find(entry => entry.income.actionId === income.actionId);
    if (!entry) invalid();
    if (entry.income.status !== income.status && !allowedIncomeTransitions[entry.income.status].includes(income.status)) invalid();
    // Lifecycle updates cannot rewrite the original expected-income record.
    const immutable = (value: ExpectedIncome) => encodeIncome(value).filter((_, index) => index !== 7);
    if (JSON.stringify(immutable(entry.income)) !== JSON.stringify(immutable(income))) invalid();
    this.write(entry.row, income);
  }

  private sheet() {
    assertPlanningHeaders(this.auth.workbook);
    const sheet = this.auth.workbook.getSheetByName("Pendapatan Diharapkan");
    if (!sheet || sheet.getMaxRows() < LAST_PLANNING_ROW || this.auth.workbook.getSpreadsheetTimeZone() !== "Asia/Jakarta") invalid();
    return sheet;
  }

  private entries(): { row: number; income: ExpectedIncome }[] {
    try {
      const range = this.sheet().getRange(`A2:I${LAST_PLANNING_ROW}`);
      const values = range.getValues();
      if (range.getFormulas().some(row => row.some(value => value !== ""))) invalid();
      const entries: { row: number; income: ExpectedIncome }[] = [];
      const ids = new Set<string>();
      values.forEach((row, index) => {
        if (row.every(value => value === "")) return;
        const income = decodeIncome(row);
        if (ids.has(income.actionId)) invalid();
        ids.add(income.actionId); entries.push({ row: index + 2, income });
      });
      return entries;
    } catch { return invalid(); }
  }

  private write(row: number, income: ExpectedIncome): void {
    const values = encodeIncome(income);
    decodeIncome(values); // Reject invalid repository values before any write.
    this.sheet().getRange(row, 1, 1, EXPECTED_INCOME_HEADERS.length).setValues([values.map(value =>
      typeof value === "string" && value.startsWith("=") ? `'${value}` : value,
    )]);
  }
}

function encodeIncome(income: ExpectedIncome): unknown[] {
  return [income.actionId, new Date(income.createdAt), income.createdBy, new Date(`${income.expectedDate}T00:00:00+07:00`),
    income.source, income.destinationAccount, income.amount, income.status, income.note];
}

function decodeIncome(row: unknown[]): ExpectedIncome {
  try {
    if (row.length !== EXPECTED_INCOME_HEADERS.length) invalid();
    const actionId = parseActionId(row[0]); const createdAt = sheetClock(row[1]).nowIso;
    const createdBy = parseText(row[2]); const expectedDate = sheetClock(row[3]).today;
    const source = parseText(row[4]); const destinationAccount = parseText(row[5]);
    const amount = parseMoney(row[6]); if (!amount) invalid();
    if (typeof row[7] !== "string" || !Object.hasOwnProperty.call(allowedIncomeTransitions, row[7])) invalid();
    const status = row[7] as IncomeStatus;
    const note = row[8] === "" ? "" : parseText(row[8]);
    return { actionId, createdAt, createdBy, expectedDate, source, destinationAccount, amount, status, note };
  } catch { return invalid(); }
}

function sheetClock(value: unknown) { if (!(value instanceof Date)) invalid(); return jakartaClock(value); }
function invalid(): never { throw new DomainError("WORKBOOK_SCHEMA_INVALID"); }
