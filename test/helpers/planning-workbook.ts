import structure from "../fixtures/workbook-structure.json";
import { syntheticSourceMap } from "./fake-workbook";

type Cell = unknown;
export class MemorySheet {
  cells = new Map<string, Cell>();
  formulas = new Map<string, string>();
  formats = new Map<string, string>();
  protections: any[] = [];
  frozen = 0;
  rows = 1100;
  columns = 26;
  constructor(public name: string, public minRows = 0, public minColumns = 0) {}
  getName() { return this.name; }
  getLastRow() { return Math.max(this.minRows, ...[...this.cells.keys(), ...this.formulas.keys()].map(key => Number(key.split(",")[0])), 0); }
  getLastColumn() { return Math.max(this.minColumns, ...[...this.cells.keys(), ...this.formulas.keys()].map(key => Number(key.split(",")[1])), 0); }
  getMaxRows() { return this.rows; }
  getMaxColumns() { return this.columns; }
  insertRowsAfter(_after: number, count: number) { this.rows += count; return this; }
  insertColumnsAfter(_after: number, count: number) { this.columns += count; return this; }
  getDataRange() { return this.getRange(1, 1, Math.max(1, this.getLastRow()), Math.max(1, this.getLastColumn())); }
  setFrozenRows(value: number) { this.frozen = value; return this; }
  getProtections(type: string) { return this.protections.filter(p => p.type === type); }
  protect() {
    const p: any = {
      type: "SHEET", description: "", editors: [], ranges: [], domain: true, warning: true,
      getDescription: () => p.description,
      setDescription: (v: string) => { p.description = v; return p; },
      setWarningOnly: (v: boolean) => { p.warning = v; return p; },
      addEditors: (v: string[]) => { p.editors = [...new Set([...p.editors, ...v])]; return p; },
      getEditors: () => p.editors.map((email: string) => ({ getEmail: () => email })),
      removeEditors: (v: any[]) => { const emails = v.map(x => typeof x === "string" ? x : x.getEmail()); p.editors = p.editors.filter((e: string) => !emails.includes(e)); return p; },
      canDomainEdit: () => p.domain,
      setDomainEdit: (v: boolean) => { p.domain = v; return p; },
      setUnprotectedRanges: (v: any[]) => { p.ranges = v; return p; },
    };
    this.protections.push(p); return p;
  }
  getRange(a: string | number, col?: number, height = 1, width = 1): any {
    let row: number;
    if (typeof a === "string") {
      const m = /^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/.exec(a)!;
      row = Number(m[2]); col = column(m[1]);
      height = Number(m[4] ?? m[2]) - row + 1; width = column(m[3] ?? m[1]) - col + 1;
    } else row = a;
    const c = col!;
    const a1 = `${letters(c)}${row}${height === 1 && width === 1 ? "" : `:${letters(c + width - 1)}${row + height - 1}`}`;
    const read = (map: Map<string, any>) => Array.from({ length: height }, (_, r) => Array.from({ length: width }, (_, k) => map.get(`${row + r},${c + k}`) ?? ""));
    const write = (map: Map<string, any>, values: any[][]) => { values.forEach((line, r) => line.forEach((v, k) => map.set(`${row + r},${c + k}`, v))); return range; };
    const range: any = {
      getValues: () => read(this.cells), getFormulas: () => read(this.formulas),
      getValue: () => read(this.cells)[0][0], getFormula: () => read(this.formulas)[0][0],
      setValues: (v: any[][]) => write(this.cells, v), setValue: (v: any) => write(this.cells, [[v]]),
      setFormulas: (v: string[][]) => write(this.formulas, v), setFormula: (v: string) => write(this.formulas, [[v]]),
      setNumberFormat: (v: string) => { this.formats.set(a1, v); return range; },
      getSheet: () => this, getA1Notation: () => a1,
    }; return range;
  }
}

export function planningWorkbook() {
  const sheets = new Map<string, MemorySheet>();
  for (const info of structure.healthy.sheets) {
    const sheet = new MemorySheet(info.name, info.dimensions.rows, info.dimensions.columns);
    for (const h of info.headers) sheet.getRange(h.a1).setValue(h.label);
    for (const a1 of info.formulaLocations ?? []) sheet.getRange(a1).setFormula("=TODAY()");
    sheets.set(info.name, sheet);
  }
  const names = new Map<string, any>();
  const created: string[] = [];
  const workbook = {
    getSheets: () => [...sheets.values()],
    getSheetByName: (name: string) => sheets.get(name) ?? null,
    insertSheet: (name: string) => { const s = new MemorySheet(name); sheets.set(name, s); created.push(name); return s; },
    getSpreadsheetTimeZone: () => "Asia/Jakarta",
    getNamedRanges: () => [...names].map(([name, range]) => ({ getName: () => name, getRange: () => range })),
    setNamedRange: (name: string, range: any) => names.set(name, range),
    getRangeByName: (name: string) => names.get(name) ?? null,
    getEditors: () => [{ getEmail: () => "second@example.test" }],
    getOwner: () => ({ getEmail: () => "first@example.test" }),
  } as unknown as GoogleAppsScript.Spreadsheet.Spreadsheet;
  sheets.get("Atur Budgeting")!.getRange("D2:E3").setValues([["Dining", 300000], ["Dining", 200000]]);
  sheets.get("Profil Kemampuan Menabung")!.getRange("B2:D2").setValues([[1000000, 500000, 200000]]);
  sheets.get("Catat - Pendapatan")!.getRange("B2").setValue(new Date("2026-09-01T00:00:00+07:00"));
  sheets.get("Catat - Pendapatan")!.getRange("F2").setValue(1000000);
  sheets.get("backend")!.getRange("B2:C2").setValues([["Main Account", 1000000]]);
  sheets.get("backend")!.getRange("G2").setValue("2026-09-23");
  return { workbook, sheets, names, created, map: syntheticSourceMap(), auth: { email: "first@example.test", workbook } };
}

function column(text: string) { return [...text].reduce((n, v) => n * 26 + v.charCodeAt(0) - 64, 0); }
function letters(n: number): string { return n <= 26 ? String.fromCharCode(64 + n) : letters(Math.floor((n - 1) / 26)) + String.fromCharCode(65 + (n - 1) % 26); }
