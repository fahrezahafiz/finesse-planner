import { DomainError } from "../../domain/errors";
import { parseApprovedBaselineChange, type ApprovedBaselineChangeCommand } from "../../domain/insights";
import type { RequestClock } from "../../domain/time";
import type { AuthContext } from "../auth";
import { withDocumentLock, type DocumentLock } from "../lock";
import { validateWorkbookSchema } from "../workbook/schema";
import type { WorkbookSourceMap } from "../workbook/source-map";

/** The secure RPC boundary supplies the authorized workbook and one captured request clock. */
export interface BaselineReviewServiceDeps {
  auth: AuthContext;
  clock: RequestClock;
  sourceMap: WorkbookSourceMap;
  lock: DocumentLock | null;
  flush?: () => void;
}

export interface AppliedBaselineChange {
  readonly category: string;
  readonly previousAmount: number;
  readonly newAmount: number;
}

export interface BaselineReviewResult {
  readonly actionId: string;
  readonly appliedAt: string;
  readonly appliedBy: string;
  readonly reason: string;
  readonly changes: readonly AppliedBaselineChange[];
}

interface BaselineCell {
  readonly row: number;
  readonly column: number;
  readonly value: number;
}

/**
 * Applies a human-approved, zero-sum baseline rebalancing directly to the calibrated
 * WorkbookSourceMap.baseline cells. This is the only function in the insights feature that writes
 * anything; analyzeTransferPatterns and proposeBaselineReview only ever produce suggestions.
 *
 * Write safety: acquire the document lock, revalidate the workbook schema, locate each changed
 * category's exact single baseline row, and reject closed (never overwrite) if that row is missing,
 * ambiguous (the category appears on more than one baseline row), or its value no longer matches what
 * the reviewer saw. There is no separate audit ledger for this write (the plan's five-file scope has
 * no new repository/sheet for it), so replaying the same approval is made safe by checking whether the
 * target cells already hold the approved newAmount and, if so, returning the same result instead of
 * re-validating staleness against values that are now expected to differ.
 */
export function applyApprovedBaselineChange(command: unknown, deps: BaselineReviewServiceDeps): BaselineReviewResult {
  const approved = parseApprovedBaselineChange(command);
  return withDocumentLock(deps.lock, () => {
    validateWorkbookSchema(deps.auth.workbook, deps.sourceMap);
    const categories = approved.changes.map(change => change.category);
    const cells = locateBaselineCells(deps.auth, deps.sourceMap, categories);

    if (approved.changes.every(change => cells.get(change.category)!.value === change.newAmount)) {
      return buildResult(approved, deps);
    }
    if (approved.changes.some(change => cells.get(change.category)!.value !== change.expectedAmount)) {
      throw new DomainError("BASELINE_CELL_STALE");
    }

    const sheet = deps.auth.workbook.getSheetByName(deps.sourceMap.baseline.plannedAmount.sheet)!;
    for (const change of approved.changes) {
      const cell = cells.get(change.category)!;
      sheet.getRange(cell.row, cell.column).setValue(change.newAmount);
    }
    flush(deps);
    return buildResult(approved, deps);
  });
}

function buildResult(approved: ApprovedBaselineChangeCommand, deps: BaselineReviewServiceDeps): BaselineReviewResult {
  return {
    actionId: approved.actionId,
    appliedAt: deps.clock.nowIso,
    appliedBy: deps.auth.email,
    reason: approved.reason,
    changes: approved.changes.map(change => ({ category: change.category, previousAmount: change.expectedAmount, newAmount: change.newAmount })),
  };
}

/**
 * Locates the single baseline row for each requested category. Baseline categories can legitimately
 * be summed across multiple rows for reporting (see formulas.ts's aggregateBaseline), but a
 * rebalancing write must target one exact cell. When a category being changed maps to zero rows or
 * more than one row, this fails closed rather than guessing which row to overwrite or silently
 * summing rows into one write.
 */
function locateBaselineCells(auth: AuthContext, sourceMap: WorkbookSourceMap, categories: readonly string[]): Map<string, BaselineCell> {
  const categoryRange = sourceMap.baseline.category;
  const amountRange = sourceMap.baseline.plannedAmount;
  const categorySheet = auth.workbook.getSheetByName(categoryRange.sheet);
  const amountSheet = auth.workbook.getSheetByName(amountRange.sheet);
  if (!categorySheet || !amountSheet) throw new DomainError("BASELINE_CELL_STALE");

  const categoryValues = categorySheet.getRange(categoryRange.a1).getValues();
  const amountValues = amountSheet.getRange(amountRange.a1).getValues();
  if (categoryValues.length !== amountValues.length) throw new DomainError("BASELINE_CELL_STALE");

  const startRow = parseStartRow(categoryRange.a1);
  const column = parseStartColumn(amountRange.a1);
  const wanted = new Set(categories);
  const rowsByCategory = new Map<string, BaselineCell[]>();
  categoryValues.forEach((row, index) => {
    const label = row[0];
    if (typeof label !== "string" || label === "" || !wanted.has(label)) return;
    const amount = amountValues[index]![0];
    if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < 0) throw new DomainError("BASELINE_CELL_STALE");
    const list = rowsByCategory.get(label) ?? [];
    list.push({ row: startRow + index, column, value: amount });
    rowsByCategory.set(label, list);
  });

  const result = new Map<string, BaselineCell>();
  for (const category of categories) {
    const rows = rowsByCategory.get(category);
    if (!rows || rows.length !== 1) throw new DomainError("BASELINE_CELL_STALE");
    result.set(category, rows[0]!);
  }
  return result;
}

function parseStartRow(a1: string): number {
  const match = /^[A-Z]+(\d+)/.exec(a1);
  if (!match) throw new DomainError("BASELINE_CELL_STALE");
  return Number(match[1]);
}

function parseStartColumn(a1: string): number {
  const match = /^([A-Z]+)/.exec(a1);
  if (!match) throw new DomainError("BASELINE_CELL_STALE");
  return [...match[1]!].reduce((n, letter) => n * 26 + letter.charCodeAt(0) - 64, 0);
}

function flush(deps: BaselineReviewServiceDeps): void { (deps.flush ?? (() => SpreadsheetApp.flush()))(); }
