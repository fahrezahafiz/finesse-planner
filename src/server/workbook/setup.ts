import { DomainError } from "../../domain/errors";
import type { AuthContext } from "../auth";
import { buildSummaryFormulas, sourceNamedRanges, SUMMARY_NAMED_RANGES } from "./formulas";
import { HOUSEHOLD_LABELS, LAST_PLANNING_ROW, PLANNING_CAPACITY, PLANNING_SHEETS } from "./headers";
import { validateWorkbookSchema } from "./schema";
import type { WorkbookSourceMap } from "./source-map";

export function setupPlanningSheets(auth: AuthContext, sourceMap?: WorkbookSourceMap): void {
  const map = validateWorkbookSchema(auth.workbook, sourceMap).sourceMap;
  if (map.timeZone !== "Asia/Jakarta") invalid();
  for (const scalar of [...Object.values(map.savingsProfile), map.formulaFreshness]) {
    if (!/^[A-Z]+[1-9]\d*$/.test(scalar.a1)) invalid();
  }
  const owner = auth.workbook.getOwner()?.getEmail();
  const editors = [...new Set([owner, ...auth.workbook.getEditors().map(user => user.getEmail())].filter((email): email is string => Boolean(email)))];
  if (editors.length !== 2 || !editors.includes(auth.email)) invalid();
  // Check every existing sheet before creating or changing anything.
  assertPlanningHeaders(auth.workbook, true);
  for (const { name, headers } of PLANNING_SHEETS) {
    const existing = auth.workbook.getSheetByName(name);
    const sheet = existing ?? auth.workbook.insertSheet(name);
    if (sheet.getMaxRows() < LAST_PLANNING_ROW) sheet.insertRowsAfter(sheet.getMaxRows(), LAST_PLANNING_ROW - sheet.getMaxRows());
    if (sheet.getMaxColumns() < Math.max(headers.length, 11)) sheet.insertColumnsAfter(sheet.getMaxColumns(), Math.max(headers.length, 11) - sheet.getMaxColumns());
    if (!existing) sheet.getRange(1, 1, 1, headers.length).setValues([[...headers]]);
    sheet.setFrozenRows(1);
    formatSheet(sheet);
    const tag = "Finesse planning controlled inputs";
    const matches = sheet.getProtections("SHEET" as unknown as GoogleAppsScript.Spreadsheet.ProtectionType).filter(p => p.getDescription() === tag);
    if (matches.length > 1) invalid();
    const protection = matches[0] ?? sheet.protect().setDescription(tag);
    protection.setWarningOnly(false);
    protection.addEditors(editors);
    const unwanted = protection.getEditors().filter(user => !editors.includes(user.getEmail()));
    if (unwanted.length) protection.removeEditors(unwanted);
    if (protection.canDomainEdit()) protection.setDomainEdit(false);
    const inputRanges = name === "Rencana Pengeluaran" ? ["D2:L1001", "S2:S1001"]
      : name === "Transfer Budget" ? ["D2:K1001"]
      : name === "Pendapatan Diharapkan" ? ["D2:I1001"] : [];
    protection.setUnprotectedRanges(inputRanges.map(a1 => sheet.getRange(a1)));
  }
  for (const [name, range] of Object.entries(sourceNamedRanges(map))) {
    auth.workbook.setNamedRange(name, auth.workbook.getSheetByName(range.sheet)!.getRange(range.a1));
  }
  const summary = auth.workbook.getSheetByName("Ringkasan Perencanaan")!;
  for (const [name, a1] of Object.entries(SUMMARY_NAMED_RANGES)) auth.workbook.setNamedRange(name, summary.getRange(a1));
  summary.getRange("J1:J12").setValues(HOUSEHOLD_LABELS.map(label => [label]));
  const formulas = buildSummaryFormulas();
  summary.getRange("A2").setFormula(formulas.categoryNames);
  summary.getRange(2, 2, PLANNING_CAPACITY, 7).setFormulas(formulas.categories);
  summary.getRange("K1:K12").setFormulas(formulas.household);
}

export function assertPlanningHeaders(workbook: GoogleAppsScript.Spreadsheet.Spreadsheet, allowMissing = false): void {
  for (const { name, headers } of PLANNING_SHEETS) {
    const sheet = workbook.getSheetByName(name);
    if (!sheet) { if (allowMissing) continue; invalid(); }
    if (sheet.getMaxColumns() < headers.length || sheet.getLastRow() > LAST_PLANNING_ROW) invalid();
    const values = sheet.getRange(1, 1, 1, Math.max(headers.length, sheet.getLastColumn())).getValues()[0];
    if (!headers.every((header, i) => values[i] === header)) invalid();
    if (name === "Ringkasan Perencanaan") {
      const labels = sheet.getRange("J1:J12").getValues();
      if (!HOUSEHOLD_LABELS.every((label, i) => labels[i]?.[0] === label) || values[8] !== "" || values.slice(11).some(value => value !== "")) invalid();
    } else if (values.slice(headers.length).some(value => value !== "")) invalid();
  }
}

function formatSheet(sheet: GoogleAppsScript.Spreadsheet.Sheet): void {
  const name = sheet.getName();
  if (name === "Ringkasan Perencanaan") {
    sheet.getRange("B2:H1001").setNumberFormat("#,##0"); sheet.getRange("K1:K8").setNumberFormat("#,##0");
    sheet.getRange("K10").setNumberFormat("#,##0"); sheet.getRange("K11").setNumberFormat("yyyy-mm"); sheet.getRange("K12").setNumberFormat("yyyy-mm-dd");
    return;
  }
  sheet.getRange("B2:B1001").setNumberFormat("yyyy-mm-dd hh:mm:ss");
  if (name === "Rencana Pengeluaran") {
    sheet.getRange("D2:D1001").setNumberFormat("yyyy-mm"); sheet.getRange("E2:E1001").setNumberFormat("yyyy-mm-dd");
    sheet.getRange("I2:R1001").setNumberFormat("#,##0"); sheet.getRange("T2:T1001").setNumberFormat("yyyy-mm-dd hh:mm:ss");
  } else {
    sheet.getRange("D2:D1001").setNumberFormat(name === "Transfer Budget" ? "yyyy-mm" : "yyyy-mm-dd");
    sheet.getRange("G2:G1001").setNumberFormat("#,##0");
  }
}
function invalid(): never { throw new DomainError("WORKBOOK_SCHEMA_INVALID"); }
