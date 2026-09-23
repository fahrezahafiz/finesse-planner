import fixtureData from "../fixtures/workbook-structure.json";
import { describe, expect, it } from "vitest";
import { validateStructure, validateWorkbookSchema } from "../../src/server/workbook/schema";
import { fakeWorkbook, syntheticSourceMap } from "../helpers/fake-workbook";
import type { WorkbookStructure } from "../../src/server/workbook/audit";

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
});
