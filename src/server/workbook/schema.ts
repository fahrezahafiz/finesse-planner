import { DomainError } from "../../domain/errors";
import {
  auditWorkbookStructure,
  normalizeHeaderLabel,
  type HeaderSearchRegion,
  type WorkbookStructure,
} from "./audit";
import {
  REQUIRED_EXISTING_SHEETS,
  sourceMapAnchors,
  sourceMapRanges,
  type HeaderAnchor,
  type SourceRange,
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

  const structure = auditWorkbookStructure(workbook, {
    headerSearchRegions: headerSearchRegions(sourceMapAnchors(sourceMap)),
  });
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
  if (!["B", "C", "D", "E", "F"].every(column => expenseInputColumns.includes(column))) invalid();

  return {
    sheetNames: structure.sheetNames,
    expenseInputColumns: ["B", "C", "D", "E", "F"],
  };
}

function validateSourceMap(structure: WorkbookStructure, sourceMap: WorkbookSourceMap): void {
  if (sourceMap.timeZone !== structure.timeZone) invalid();
  const sheets = new Map(structure.sheets.map(sheet => [sheet.name, sheet]));

  for (const contract of rangeContracts(sourceMap)) {
    validateRangeContract(sheets, contract.range, contract.expectedSheet);
  }

  validateExpenseColumns(sourceMap);
  for (const ranges of [
    [sourceMap.actualIncome.date, sourceMap.actualIncome.amount],
    [sourceMap.baseline.category, sourceMap.baseline.plannedAmount],
    [sourceMap.accounts.names, sourceMap.accounts.currentBalances],
  ]) {
    const parsed = ranges.map(range => parseRange(range.a1)!);
    if (parsed.some(range => range.startRow !== parsed[0]!.startRow || range.endRow !== parsed[0]!.endRow)) invalid();
  }
  validateAnchors(sheets, sourceMapAnchors(sourceMap));

  const freshnessSheet = sheets.get(sourceMap.formulaFreshness.sheet);
  if (!freshnessSheet?.formulaLocations?.includes(startCell(sourceMap.formulaFreshness.a1))) invalid();
}

function validateExpenseColumns(sourceMap: WorkbookSourceMap): void {
  const ranges = [
    sourceMap.expenseInput.date,
    sourceMap.expenseInput.category,
    sourceMap.expenseInput.detail,
    sourceMap.expenseInput.account,
    sourceMap.expenseInput.amount,
  ];
  const parsedRanges = ranges.map(range => parseRange(range.a1));
  const validRanges = parsedRanges.filter((range): range is NonNullable<typeof range> => range !== undefined);
  if (validRanges.length !== parsedRanges.length) invalid();
  const columns = validRanges.map(range => range.startColumnLabel);
  if (!sameColumns(columns, ["B", "C", "D", "E", "F"])) invalid();
  const first = validRanges[0]!;
  if (!validRanges.every(range => range.startRow === first.startRow && range.endRow === first.endRow)) invalid();
}

function validateRangeContract(
  sheets: ReadonlyMap<string, WorkbookStructure["sheets"][number]>,
  range: SourceRange,
  expectedSheet: string,
): void {
  if (range.sheet !== expectedSheet) invalid();
  const sheet = sheets.get(range.sheet);
  const parsedRange = parseRange(range.a1);
  const header = parseRange(range.header.a1);
  if (!sheet || !parsedRange || !header || !rangeFits(parsedRange, sheet.dimensions)) invalid();
  if (parsedRange.startColumn !== parsedRange.endColumn
    || header.startColumn !== header.endColumn
    || header.startRow !== header.endRow
    || parsedRange.startColumn !== header.startColumn) invalid();
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

function headerSearchRegions(anchors: readonly HeaderAnchor[]): readonly HeaderSearchRegion[] {
  return anchors.flatMap(anchor => {
    const header = parseRange(anchor.a1);
    return header && header.startColumn === header.endColumn && header.startRow === header.endRow
      ? [{ sheet: anchor.sheet, row: header.startRow }]
      : [];
  });
}

function rangeContracts(sourceMap: WorkbookSourceMap): readonly {
  readonly range: SourceRange;
  readonly expectedSheet: string;
}[] {
  return [
    { range: sourceMap.baseline.category, expectedSheet: "Atur Budgeting" },
    { range: sourceMap.baseline.plannedAmount, expectedSheet: "Atur Budgeting" },
    { range: sourceMap.savingsProfile.plannedIncome, expectedSheet: "Profil Kemampuan Menabung" },
    { range: sourceMap.savingsProfile.plannedExpenses, expectedSheet: "Profil Kemampuan Menabung" },
    { range: sourceMap.savingsProfile.protectedMonthlySavings, expectedSheet: "Profil Kemampuan Menabung" },
    { range: sourceMap.expenseInput.date, expectedSheet: "Catat - Pengeluaran" },
    { range: sourceMap.expenseInput.category, expectedSheet: "Catat - Pengeluaran" },
    { range: sourceMap.expenseInput.detail, expectedSheet: "Catat - Pengeluaran" },
    { range: sourceMap.expenseInput.account, expectedSheet: "Catat - Pengeluaran" },
    { range: sourceMap.expenseInput.amount, expectedSheet: "Catat - Pengeluaran" },
    { range: sourceMap.actualIncome.date, expectedSheet: "Catat - Pendapatan" },
    { range: sourceMap.actualIncome.amount, expectedSheet: "Catat - Pendapatan" },
    { range: sourceMap.cashTransfer, expectedSheet: "Catat - Pindah Kas/Nabung" },
    { range: sourceMap.accounts.names, expectedSheet: "backend" },
    { range: sourceMap.accounts.currentBalances, expectedSheet: "backend" },
    { range: sourceMap.formulaFreshness, expectedSheet: "backend" },
  ];
}

function exactlyOneSheet(structure: WorkbookStructure, name: string) {
  const sheets = structure.sheets.filter(sheet => sheet.name === name);
  if (sheets.length !== 1) invalid();
  return sheets[0]!;
}

function isCalibrated(sourceMap: WorkbookSourceMap): boolean {
  try {
    return sourceMap.calibration.source === "development-copy-audit"
      && !Number.isNaN(Date.parse(sourceMap.calibration.auditedAt))
      && sourceMapRanges(sourceMap).every(range => range && typeof range.sheet === "string"
        && typeof range.a1 === "string" && typeof range.header?.a1 === "string" && typeof range.header.label === "string");
  } catch { return false; }
}

function parseRange(a1: string): {
  readonly startColumn: number;
  readonly startColumnLabel: string;
  readonly startRow: number;
  readonly endColumn: number;
  readonly endRow: number;
} | undefined {
  const match = /^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/.exec(a1);
  if (!match) return undefined;
  const startColumn = columnNumber(match[1]!);
  const startRow = Number(match[2]);
  const endColumn = columnNumber(match[3] ?? match[1]!);
  const endRow = Number(match[4] ?? match[2]!);
  if (startColumn <= 0 || startRow <= 0 || endColumn < startColumn || endRow < startRow) return undefined;
  return { startColumn, startColumnLabel: match[1]!, startRow, endColumn, endRow };
}

function rangeFits(
  range: ReturnType<typeof parseRange>,
  dimensions: { readonly rows: number; readonly columns: number },
): boolean {
  return range !== undefined && range.endColumn <= dimensions.columns && range.endRow <= dimensions.rows;
}

function startCell(a1: string): string {
  return a1.split(":", 1)[0]!;
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
