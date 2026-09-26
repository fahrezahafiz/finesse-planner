import { DomainError } from "../../domain/errors";
import { parseActionId, parseText } from "../../domain/plans";
import { allowedTransferTransitions, type Transfer, type TransferStatus } from "../../domain/transfers";
import { jakartaClock } from "../../domain/time";
import { parseMoney, parseYearMonth } from "../../domain/validation";
import type { AuthContext } from "../auth";
import { LAST_PLANNING_ROW, TRANSFER_HEADERS } from "./headers";
import { assertPlanningHeaders } from "./setup";

/** All reads and writes use the workbook already opened under the caller's authority. */
export class TransferRepository {
  constructor(private readonly auth: AuthContext) {}

  list(): Transfer[] { return this.entries().map(entry => entry.transfer); }

  append(transfer: Transfer): void {
    const entries = this.entries();
    if (entries.some(entry => entry.transfer.actionId === transfer.actionId)) invalid();
    const lastRow = Math.max(1, ...entries.map(entry => entry.row));
    if (lastRow >= LAST_PLANNING_ROW) invalid();
    this.write(lastRow + 1, transfer);
  }

  update(transfer: Transfer): void {
    const entry = this.entries().find(entry => entry.transfer.actionId === transfer.actionId);
    if (!entry) invalid();
    if (entry.transfer.status !== transfer.status && !allowedTransferTransitions[entry.transfer.status].includes(transfer.status)) invalid();
    // Lifecycle updates cannot rewrite the original transfer or its reversal reference.
    const immutable = (value: Transfer) => encodeTransfer(value).filter((_, index) => index !== 9);
    if (JSON.stringify(immutable(entry.transfer)) !== JSON.stringify(immutable(transfer))) invalid();
    this.write(entry.row, transfer);
  }

  /** Atomically appends a reversal row and flips its original row in one range write. */
  commitReversal(original: Transfer, reversal: Transfer): void {
    const entries = this.entries();
    const originalEntry = entries.find(entry => entry.transfer.actionId === original.actionId);
    if (!originalEntry || originalEntry.transfer.status !== "ACTIVE") invalid();
    const existing = entries.find(entry => entry.transfer.actionId === reversal.actionId);
    if (existing && existing.transfer.reversalReference !== original.actionId) invalid();
    const lastRow = Math.max(1, ...entries.map(entry => entry.row));
    if (!existing && lastRow >= LAST_PLANNING_ROW) invalid();
    const range = this.sheet().getRange(`A2:K${LAST_PLANNING_ROW}`);
    const values = range.getValues();
    values[originalEntry.row - 2] = encodeTransfer({ ...original, status: "REVERSED" });
    if (!existing) values[lastRow - 1] = encodeTransfer(reversal);
    range.setValues(values.map(row => row.map(value =>
      typeof value === "string" && value.startsWith("=") ? `'${value}` : value,
    )));
  }

  private sheet() {
    assertPlanningHeaders(this.auth.workbook);
    const sheet = this.auth.workbook.getSheetByName("Transfer Budget");
    if (!sheet || sheet.getMaxRows() < LAST_PLANNING_ROW || this.auth.workbook.getSpreadsheetTimeZone() !== "Asia/Jakarta") invalid();
    return sheet;
  }

  private entries(): { row: number; transfer: Transfer }[] {
    try {
      const range = this.sheet().getRange(`A2:K${LAST_PLANNING_ROW}`);
      const values = range.getValues();
      if (range.getFormulas().some(row => row.some(value => value !== ""))) invalid();
      const entries: { row: number; transfer: Transfer }[] = [];
      const ids = new Set<string>();
      values.forEach((row, index) => {
        if (row.every(value => value === "")) return;
        const transfer = decodeTransfer(row);
        if (ids.has(transfer.actionId)) invalid();
        ids.add(transfer.actionId); entries.push({ row: index + 2, transfer });
      });
      return entries;
    } catch { return invalid(); }
  }

  private write(row: number, transfer: Transfer): void {
    const values = encodeTransfer(transfer);
    decodeTransfer(values); // Reject invalid repository values before any write.
    this.sheet().getRange(row, 1, 1, TRANSFER_HEADERS.length).setValues([values.map(value =>
      typeof value === "string" && value.startsWith("=") ? `'${value}` : value,
    )]);
  }
}

function encodeTransfer(transfer: Transfer): unknown[] {
  return [transfer.actionId, new Date(transfer.createdAt), transfer.createdBy, transfer.month, transfer.fromCategory, transfer.toCategory,
    transfer.amount, transfer.reason, transfer.relatedPlanId, transfer.status, transfer.reversalReference];
}

function decodeTransfer(row: unknown[]): Transfer {
  try {
    if (row.length !== TRANSFER_HEADERS.length) invalid();
    const actionId = parseActionId(row[0]); const createdAt = sheetClock(row[1]).nowIso;
    const createdBy = parseText(row[2]); const month = parseYearMonth(row[3]);
    const fromCategory = parseText(row[4]); const toCategory = parseText(row[5]);
    if (fromCategory === toCategory) invalid();
    const amount = parseMoney(row[6]); if (!amount) invalid();
    const reason = parseText(row[7]);
    const relatedPlanId = row[8] === "" ? "" : parseActionId(row[8]);
    if (typeof row[9] !== "string" || !Object.hasOwnProperty.call(allowedTransferTransitions, row[9])) invalid();
    const status = row[9] as TransferStatus;
    const reversalReference = row[10] === "" ? "" : parseActionId(row[10]);
    return { actionId, createdAt, createdBy, month, fromCategory, toCategory, amount, reason, relatedPlanId, status, reversalReference };
  } catch { return invalid(); }
}

function sheetClock(value: unknown) { if (!(value instanceof Date)) invalid(); return jakartaClock(value); }
function invalid(): never { throw new DomainError("WORKBOOK_SCHEMA_INVALID"); }
