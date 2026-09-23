import { DomainError } from "../../domain/errors";
import { auditWorkbookStructure, normalizeHeaderLabel, type WorkbookStructure } from "./audit";
import {
  REQUIRED_EXISTING_SHEETS,
  sourceMapAnchors,
  sourceMapRanges,
  type HeaderAnchor,
  type WorkbookSourceMap,
} from "./source-map";

export interface ValidatedWorkbookSchema {
  readonly sheetNames: readonly string[];
  readonly expenseInputColumns: readonly ["B", "C", "D", "E", "F"];
  readonly sourceMap: WorkbookSourceMap;
}

export function validateWorkbookSchema(
  workbook: GoogleAppsScript.Spreadsheet.Spreadsheet,
  sourceMap?: WorkbookSourceMap,
): ValidatedWorkbookSchema {
  if (!sourceMap || !isCalibrated(sourceMap)) invalid();

  const structure = auditWorkbookStructure(workbook, { headerAnchors: sourceMapAnchors(sourceMap) });
  const result = validateStructure(structure);
  validateSourceMap(structure, sourceMap);

  return { ...result, sourceMap };
}

export function validateStructure(structure: WorkbookStructure): Omit<ValidatedWorkbookSchema, "sourceMap"> {
  for (const name of REQUIRED_EXISTING_SHEETS) {
    if (structure.sheetNames.filter(sheetName => sheetName === name).length !== 1) invalid();
  }

  const expenseSheet = exactlyOneSheet(structure, "Catat - Pengeluaran");
  const headersByLabel = new Set<string>();
  for (const sheet of structure.sheets) {
    for (const header of sheet.headers) {
      const normalized = normalizeHeaderLabel(header.label);
      if (!normalized || headersByLabel.has(`${sheet.name}:${normalized}`)) invalid();
      headersByLabel.add(`${sheet.name}:${normalized}`);
    }
  }

  const expenseInputColumns = expenseSheet.headers
    .map(header => header.column)
    .sort(compareColumns);
  if (!sameColumns(expenseInputColumns, ["B", "C", "D", "E", "F"])) invalid();

  return {
    sheetNames: structure.sheetNames,
    expenseInputColumns: ["B", "C", "D", "E", "F"],
  };
}

function validateSourceMap(structure: WorkbookStructure, sourceMap: WorkbookSourceMap): void {
  if (sourceMap.timeZone !== structure.timeZone) invalid();
  const sheets = new Map(structure.sheets.map(sheet => [sheet.name, sheet]));

  for (const range of sourceMapRanges(sourceMap)) {
    const sheet = sheets.get(range.sheet);
    if (!sheet || !rangeFits(range.a1, sheet.dimensions)) invalid();
  }

  validateExpenseColumns(sourceMap);
  validateAnchors(sheets, sourceMapAnchors(sourceMap));

  const freshnessSheet = sheets.get(sourceMap.formulaFreshness.sheet);
  if (!freshnessSheet?.formulaLocations?.includes(startCell(sourceMap.formulaFreshness.a1))) invalid();
}

function validateExpenseColumns(sourceMap: WorkbookSourceMap): void {
  const columns = [
    sourceMap.expenseInput.date,
    sourceMap.expenseInput.category,
    sourceMap.expenseInput.detail,
    sourceMap.expenseInput.account,
    sourceMap.expenseInput.amount,
  ].map(range => rangeColumn(range.a1));
  if (!sameColumns(columns, ["B", "C", "D", "E", "F"])) invalid();
}

function validateAnchors(
  sheets: ReadonlyMap<string, WorkbookStructure["sheets"][number]>,
  anchors: readonly HeaderAnchor[],
): void {
  if (anchors.length === 0) invalid();
  const seen = new Set<string>();
  for (const anchor of anchors) {
    const key = `${anchor.sheet}:${anchor.a1}`;
    if (seen.has(key)) invalid();
    seen.add(key);

    const sheet = sheets.get(anchor.sheet);
    const matches = sheet?.headers.filter(header =>
      header.a1 === anchor.a1 && header.normalizedLabel === normalizeHeaderLabel(anchor.label),
    ) ?? [];
    if (matches.length !== 1) invalid();
  }
}

function exactlyOneSheet(structure: WorkbookStructure, name: string) {
  const sheets = structure.sheets.filter(sheet => sheet.name === name);
  if (sheets.length !== 1) invalid();
  return sheets[0]!;
}

function isCalibrated(sourceMap: WorkbookSourceMap): boolean {
  return sourceMap.calibration.source === "development-copy-audit"
    && !Number.isNaN(Date.parse(sourceMap.calibration.auditedAt));
}

function rangeFits(a1: string, dimensions: { readonly rows: number; readonly columns: number }): boolean {
  const match = /^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/.exec(a1);
  if (!match) return false;
  const startColumn = columnNumber(match[1]!);
  const startRow = Number(match[2]);
  const endColumn = columnNumber(match[3] ?? match[1]!);
  const endRow = Number(match[4] ?? match[2]!);
  return startColumn > 0 && startRow > 0 && endColumn >= startColumn && endRow >= startRow
    && endColumn <= dimensions.columns && endRow <= dimensions.rows;
}

function startCell(a1: string): string {
  return a1.split(":", 1)[0]!;
}

function rangeColumn(a1: string): string {
  return /^([A-Z]+)\d+/.exec(a1)?.[1] ?? "";
}

function columnNumber(column: string): number {
  return [...column].reduce((result, letter) => result * 26 + letter.charCodeAt(0) - 64, 0);
}

function compareColumns(left: string, right: string): number {
  return columnNumber(left) - columnNumber(right);
}

function sameColumns(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function invalid(): never {
  throw new DomainError("WORKBOOK_SCHEMA_INVALID");
}
