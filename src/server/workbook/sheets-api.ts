import { DomainError } from "../../domain/errors";
import { parseText } from "../../domain/plans";
import { parseLocalDate, parseMoney } from "../../domain/validation";
import type { AuthContext } from "../auth";
import type { SourceRange, WorkbookSourceMap } from "./source-map";

/** Row-scoped developer metadata that marks a Catat - Pengeluaran row as one plan's actual transaction. */
export const EXPENSE_TRANSACTION_METADATA_KEY = "mindfulExpenseTransaction";

/** Catat - Pengeluaran columns B:F, in the calibrated order documented in workbook-contract.md. */
const EXPENSE_COLUMNS = ["B", "C", "D", "E", "F"] as const;

/** Sheets serial date 0 is 1899-12-30; whole-day counting needs no time zone math. */
const SHEETS_EPOCH_UTC_MS = Date.UTC(1899, 11, 30);

export interface ExpenseAppendValues {
  readonly date: string;
  readonly category: string;
  readonly detail: string;
  readonly account: string;
  readonly amount: number;
}

/** True when a Catat - Pengeluaran row already carries this transaction key. */
export function expenseTransactionExists(auth: AuthContext, transactionKey: string): boolean {
  const response = sheetsApi().Spreadsheets.DeveloperMetadata.search({
    dataFilters: [{ developerMetadataLookup: { metadataKey: EXPENSE_TRANSACTION_METADATA_KEY, metadataValue: transactionKey } }],
  }, spreadsheetId(auth));
  return (response.matchedDeveloperMetadata ?? []).length > 0;
}

/**
 * Appends exactly one Catat - Pengeluaran row (columns B:F only) after the last existing row and
 * tags that same row with a developer-metadata entry keyed by the transaction key, in a single
 * atomic Sheets v4 batchUpdate: either both the values and the metadata land, or neither does.
 * Callers must confirm the transaction key is absent first (see expenseTransactionExists) so a
 * retry after a lost acknowledgment never appends a second row for the same plan.
 */
export function appendExpenseWithKey(auth: AuthContext, sourceMap: WorkbookSourceMap, expense: ExpenseAppendValues, transactionKey: string): void {
  const rowValues = encodeRow(expense);
  const location = writeLocation(auth, sourceMap);
  sheetsApi().Spreadsheets.batchUpdate({
    requests: [
      {
        updateCells: {
          range: { sheetId: location.sheetId, startRowIndex: location.rowIndex, endRowIndex: location.rowIndex + 1, startColumnIndex: 1, endColumnIndex: 6 },
          rows: [{ values: rowValues }],
          fields: "userEnteredValue,userEnteredFormat.numberFormat",
        },
      },
      {
        createDeveloperMetadata: {
          developerMetadata: {
            location: { dimensionRange: { sheetId: location.sheetId, dimension: "ROWS", startIndex: location.rowIndex, endIndex: location.rowIndex + 1 } },
            metadataKey: EXPENSE_TRANSACTION_METADATA_KEY,
            metadataValue: transactionKey,
            visibility: "DOCUMENT",
          },
        },
      },
    ],
  }, spreadsheetId(auth));
}

function encodeRow(expense: ExpenseAppendValues): GoogleAppsScript.Sheets.Schema.CellData[] {
  try {
    const date = parseLocalDate(expense.date);
    const category = parseText(expense.category);
    const detail = parseText(expense.detail);
    const account = parseText(expense.account);
    const amount = parseMoney(expense.amount);
    if (!amount) throw new Error();
    return [
      { userEnteredValue: { numberValue: sheetsDateSerial(date) }, userEnteredFormat: { numberFormat: { type: "DATE", pattern: "yyyy-mm-dd" } } },
      { userEnteredValue: { stringValue: category } },
      { userEnteredValue: { stringValue: detail } },
      { userEnteredValue: { stringValue: account } },
      { userEnteredValue: { numberValue: amount } },
    ];
  } catch {
    // Reject a malformed row before any Sheets call, matching the repository write guard.
    throw new DomainError("WORKBOOK_SCHEMA_INVALID");
  }
}

function sheetsDateSerial(localDate: string): number {
  const [year, month, day] = localDate.split("-").map(Number);
  return Math.round((Date.UTC(year, month - 1, day) - SHEETS_EPOCH_UTC_MS) / 86400000);
}

function writeLocation(auth: AuthContext, sourceMap: WorkbookSourceMap): { sheetId: number; rowIndex: number } {
  const ranges: readonly SourceRange[] = [
    sourceMap.expenseInput.date, sourceMap.expenseInput.category, sourceMap.expenseInput.detail,
    sourceMap.expenseInput.account, sourceMap.expenseInput.amount,
  ];
  const sheetName = ranges[0].sheet;
  if (ranges.some(range => range.sheet !== sheetName)) invalid();
  const bounds = ranges.map(range => parseColumnRange(range.a1));
  if (bounds.some((bound, index) => bound.column !== EXPENSE_COLUMNS[index] || bound.start !== bounds[0].start || bound.end !== bounds[0].end)) invalid();

  const sheet = auth.workbook.getSheetByName(sheetName);
  if (!sheet) invalid();
  const dateColumn = sheet.getRange(bounds[0].start, columnNumber(EXPENSE_COLUMNS[0]), bounds[0].end - bounds[0].start + 1, 1).getValues();
  const emptyIndex = dateColumn.findIndex(row => row[0] === "");
  if (emptyIndex === -1) invalid(); // No capacity left in the calibrated bound.
  for (let i = emptyIndex; i < dateColumn.length; i++) if (dateColumn[i][0] !== "") invalid(); // No gaps: rows fill top-down.
  return { sheetId: sheet.getSheetId(), rowIndex: bounds[0].start - 1 + emptyIndex };
}

function parseColumnRange(a1: string): { column: string; start: number; end: number } {
  const match = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(a1);
  if (!match || match[1] !== match[3]) invalid();
  return { column: match[1]!, start: Number(match[2]), end: Number(match[4]) };
}

function columnNumber(letters: string): number {
  return [...letters].reduce((total, letter) => total * 26 + letter.charCodeAt(0) - 64, 0);
}

function spreadsheetId(auth: AuthContext): string { return auth.workbook.getId(); }

function sheetsApi(): GoogleAppsScript.Sheets {
  if (typeof Sheets === "undefined" || !Sheets) invalid();
  return Sheets;
}

function invalid(): never { throw new DomainError("WORKBOOK_SCHEMA_INVALID"); }
