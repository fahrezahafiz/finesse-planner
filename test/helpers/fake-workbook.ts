import type { WorkbookSourceMap } from "../../src/server/workbook/source-map";
import type { WorkbookStructure } from "../../src/server/workbook/audit";

export function syntheticSourceMap(): WorkbookSourceMap {
  return {
    calibration: { source: "development-copy-audit", auditedAt: "2026-09-23T00:00:00.000Z" },
    baseline: {
      category: range("Atur Budgeting", "D2:D50", "D1", "Synthetic baseline category"),
      plannedAmount: range("Atur Budgeting", "E2:E50", "E1", "Synthetic planned amount"),
    },
    savingsProfile: {
      plannedIncome: range("Profil Kemampuan Menabung", "B2", "B1", "Synthetic planned income"),
      plannedExpenses: range("Profil Kemampuan Menabung", "C2", "C1", "Synthetic planned expenses"),
      protectedMonthlySavings: range("Profil Kemampuan Menabung", "D2", "D1", "Synthetic protected savings"),
    },
    expenseInput: {
      date: range("Catat - Pengeluaran", "B2:B50", "B1", "Synthetic expense date"),
      category: range("Catat - Pengeluaran", "C2:C50", "C1", "Synthetic expense category"),
      detail: range("Catat - Pengeluaran", "D2:D50", "D1", "Synthetic expense detail"),
      account: range("Catat - Pengeluaran", "E2:E50", "E1", "Synthetic expense account"),
      amount: range("Catat - Pengeluaran", "F2:F50", "F1", "Synthetic expense amount"),
    },
    actualIncome: range("Catat - Pendapatan", "F2:F50", "F1", "Synthetic actual income"),
    cashTransfer: range("Catat - Pindah Kas/Nabung", "B2:B50", "B1", "Synthetic cash transfer"),
    accounts: {
      names: range("backend", "B2:B50", "B1", "Synthetic account name"),
      currentBalances: range("backend", "C2:C50", "C1", "Synthetic current balance"),
    },
    formulaFreshness: range("backend", "G2", "G1", "Synthetic formula freshness"),
    timeZone: "Asia/Jakarta",
  };
}

export function fakeWorkbook(structure: WorkbookStructure): GoogleAppsScript.Spreadsheet.Spreadsheet {
  return {
    getSheets: () => structure.sheets.map(fakeSheet),
    getNamedRanges: () => structure.namedRanges.map(namedRange => ({
      getName: () => namedRange.name,
      getRange: () => ({
        getSheet: () => ({ getName: () => namedRange.sheet }),
        getA1Notation: () => namedRange.a1,
      }),
    })),
    getSpreadsheetTimeZone: () => structure.timeZone,
  } as unknown as GoogleAppsScript.Spreadsheet.Spreadsheet;
}

function fakeSheet(sheet: WorkbookStructure["sheets"][number]) {
  const values = Array.from({ length: sheet.dimensions.rows }, () =>
    Array.from<unknown>({ length: sheet.dimensions.columns }).fill(""),
  );
  for (const header of sheet.headers) {
    values[header.row - 1]![columnNumber(header.column) - 1] = header.label;
  }
  const formulas = Array.from({ length: sheet.dimensions.rows }, () =>
    Array.from<string>({ length: sheet.dimensions.columns }).fill(""),
  );
  for (const a1 of sheet.formulaLocations ?? []) {
    const match = /^([A-Z]+)(\d+)$/.exec(a1);
    if (match) formulas[Number(match[2]) - 1]![columnNumber(match[1]!) - 1] = "=SYNTHETIC()";
  }

  return {
    getName: () => sheet.name,
    getLastRow: () => sheet.dimensions.rows,
    getLastColumn: () => sheet.dimensions.columns,
    getDataRange: () => ({ getValues: () => values, getFormulas: () => formulas }),
    getProtections: () => [],
  };
}

function columnNumber(column: string): number {
  return [...column].reduce((result, letter) => result * 26 + letter.charCodeAt(0) - 64, 0);
}

function range(sheet: string, a1: string, headerA1: string, headerLabel: string) {
  return { sheet, a1, header: { a1: headerA1, label: headerLabel } };
}
