import type { HeaderAnchor } from "./source-map";

export type CellValueType = "blank" | "boolean" | "date" | "number" | "string" | "unknown";

export interface WorkbookHeader {
  readonly label: string;
  readonly normalizedLabel: string;
  readonly column: string;
  readonly row: number;
  readonly a1: string;
}

export interface WorkbookSheetStructure {
  readonly name: string;
  readonly dimensions: { readonly rows: number; readonly columns: number };
  readonly headers: readonly WorkbookHeader[];
  readonly cellValueTypes?: readonly (readonly CellValueType[])[];
  readonly formulaLocations?: readonly string[];
  readonly protectedRanges?: readonly string[];
}

export interface WorkbookStructure {
  readonly sheetNames: readonly string[];
  readonly sheets: readonly WorkbookSheetStructure[];
  readonly namedRanges: readonly { readonly name: string; readonly sheet: string; readonly a1: string }[];
  readonly timeZone: string;
}

export interface WorkbookAuditOptions {
  /** Explicitly approved header cells. With no anchors, all values stay redacted. */
  readonly headerAnchors?: readonly Pick<HeaderAnchor, "sheet" | "a1">[];
}

/**
 * Returns metadata only. Values are never retained except at caller-approved
 * header anchors; every other cell is represented by its value type.
 */
export function auditWorkbookStructure(
  workbook: GoogleAppsScript.Spreadsheet.Spreadsheet,
  options: WorkbookAuditOptions = {},
): WorkbookStructure {
  const headersBySheet = anchorsBySheet(options.headerAnchors ?? []);
  const sheets = workbook.getSheets().map(sheet => auditSheet(sheet, headersBySheet.get(sheet.getName()) ?? []));

  return {
    sheetNames: sheets.map(sheet => sheet.name),
    sheets,
    namedRanges: workbook.getNamedRanges().map(namedRange => ({
      name: namedRange.getName(),
      sheet: namedRange.getRange().getSheet().getName(),
      a1: namedRange.getRange().getA1Notation(),
    })),
    timeZone: workbook.getSpreadsheetTimeZone(),
  };
}

export function normalizeHeaderLabel(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function auditSheet(
  sheet: GoogleAppsScript.Spreadsheet.Sheet,
  anchors: readonly Pick<HeaderAnchor, "sheet" | "a1">[],
): WorkbookSheetStructure {
  const dataRange = sheet.getDataRange();
  const values = dataRange.getValues();
  const formulas = dataRange.getFormulas();
  const approvedHeaders = new Map(anchors.map(anchor => [anchor.a1, anchor]));
  const headers: WorkbookHeader[] = [];
  const formulaLocations: string[] = [];

  values.forEach((row, rowIndex) => {
    row.forEach((value, columnIndex) => {
      const a1 = a1For(rowIndex + 1, columnIndex + 1);
      const anchor = approvedHeaders.get(a1);
      if (anchor && typeof value === "string") {
        headers.push({
          label: value,
          normalizedLabel: normalizeHeaderLabel(value),
          column: columnFor(columnIndex + 1),
          row: rowIndex + 1,
          a1,
        });
      }
      if (formulas[rowIndex]?.[columnIndex]) formulaLocations.push(a1);
    });
  });

  return {
    name: sheet.getName(),
    dimensions: { rows: sheet.getLastRow(), columns: sheet.getLastColumn() },
    headers,
    cellValueTypes: values.map(row => row.map(cellValueType)),
    formulaLocations,
    protectedRanges: sheet.getProtections("RANGE" as unknown as GoogleAppsScript.Spreadsheet.ProtectionType)
      .map(protection => protection.getRange().getA1Notation()),
  };
}

function anchorsBySheet(
  anchors: readonly Pick<HeaderAnchor, "sheet" | "a1">[],
): Map<string, Pick<HeaderAnchor, "sheet" | "a1">[]> {
  const bySheet = new Map<string, Pick<HeaderAnchor, "sheet" | "a1">[]>();
  for (const anchor of anchors) {
    const existing = bySheet.get(anchor.sheet) ?? [];
    existing.push(anchor);
    bySheet.set(anchor.sheet, existing);
  }
  return bySheet;
}

function cellValueType(value: unknown): CellValueType {
  if (value === "" || value === null || value === undefined) return "blank";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  if (value instanceof Date) return "date";
  if (typeof value === "string") return "string";
  return "unknown";
}

function a1For(row: number, column: number): string {
  return `${columnFor(column)}${row}`;
}

function columnFor(column: number): string {
  let remaining = column;
  let result = "";
  while (remaining > 0) {
    const remainder = (remaining - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    remaining = Math.floor((remaining - 1) / 26);
  }
  return result;
}
