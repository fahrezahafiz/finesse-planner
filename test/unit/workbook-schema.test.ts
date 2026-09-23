import fixtureData from "../fixtures/workbook-structure.json";
import { describe, expect, it } from "vitest";
import { validateStructure, validateWorkbookSchema } from "../../src/server/workbook/schema";
import { fakeWorkbook, syntheticSourceMap } from "../helpers/fake-workbook";
import type { WorkbookStructure } from "../../src/server/workbook/audit";
import type { WorkbookSourceMap } from "../../src/server/workbook/source-map";

function fixture(name: keyof typeof fixtureData): WorkbookStructure {
  return fixtureData[name] as WorkbookStructure;
}

describe("workbook schema contract", () => {
  it("accepts the required existing sheets and expense input columns", () => {
    const result = validateStructure(fixture("healthy"));

    expect(result.sheetNames).toContain("Atur Budgeting");
    expect(result.sheetNames).toContain("Profil Kemampuan Menabung");
    expect(result.expenseInputColumns).toEqual(["B", "C", "D", "E", "F"]);
  });

  it.each(["missing-sheet", "duplicate-label", "wrong-expense-columns"] as const)(
    "fails closed for %s",
    fixtureName => expect(() => validateStructure(fixture(fixtureName)))
      .toThrow("WORKBOOK_SCHEMA_INVALID"),
  );

  it("fails closed until a calibrated source map is supplied", () => {
    expect(() => validateWorkbookSchema(fakeWorkbook(fixture("healthy"))))
      .toThrow("WORKBOOK_SCHEMA_INVALID");
  });

  it("accepts a structural workbook only when its calibrated anchors are unambiguous", () => {
    const result = validateWorkbookSchema(
      fakeWorkbook(fixture("healthy")),
      syntheticSourceMap(),
    );

    expect(result.sourceMap.expenseInput.amount.a1).toBe("F2:F50");
  });

  it.each([
    ["a multi-column expense date range", (map: WorkbookSourceMap) => ({
      ...map,
      expenseInput: { ...map.expenseInput, date: { ...map.expenseInput.date, a1: "B2:F50" } },
    })],
    ["a baseline amount range moved away from its header", (map: WorkbookSourceMap) => ({
      ...map,
      baseline: {
        ...map.baseline,
        plannedAmount: { ...map.baseline.plannedAmount, a1: "H2:H50" },
      },
    })],
    ["swapped expense category and detail headers", (map: WorkbookSourceMap) => ({
      ...map,
      expenseInput: {
        ...map.expenseInput,
        category: { ...map.expenseInput.category, header: map.expenseInput.detail.header },
        detail: { ...map.expenseInput.detail, header: map.expenseInput.category.header },
      },
    })],
  ] as const)("fails closed for %s", (_caseName, change) => {
    expect(() => validateWorkbookSchema(
      fakeWorkbook(fixture("healthy")),
      change(syntheticSourceMap()),
    )).toThrow("WORKBOOK_SCHEMA_INVALID");
  });

  it("fails closed when an unanchored header duplicates a calibrated label", () => {
    expect(() => validateWorkbookSchema(
      fakeWorkbook(withDuplicateBaselineHeader()),
      syntheticSourceMap(),
    )).toThrow("WORKBOOK_SCHEMA_INVALID");
  });
});

function withDuplicateBaselineHeader(): WorkbookStructure {
  const healthy = fixture("healthy");
  return {
    ...healthy,
    sheets: healthy.sheets.map(sheet => sheet.name === "Atur Budgeting"
      ? {
        ...sheet,
        headers: [
          ...sheet.headers,
          {
            ...sheet.headers[0]!,
            column: "F",
            a1: "F1",
          },
        ],
      }
      : sheet),
  };
}
