import { describe, expect, it } from "vitest";
import { buildSummaryFormulas, planningMath, aggregateBaseline } from "../../src/server/workbook/formulas";

describe("planning formulas", () => {
  it("aggregates duplicate baseline categories", () => {
    expect(aggregateBaseline([["Dining", 300000], ["Dining", 200000]]).Dining).toBe(500000);
  });
  it("preserves zero-sum transfers and subtracts actuals and reservations", () => {
    expect(planningMath.adjustedBudget(500000, 200000, 100000)).toBe(600000);
    expect(planningMath.availableBudget(600000, 200000, 100000)).toBe(300000);
    expect(planningMath.spendablePool(1000000, 200000, 300000)).toBe(900000);
    expect(planningMath.headroom(900000, 1000000)).toBe(-100000);
  });
  it("emits bounded month-specific SUMIFS and the exact budget relationships", () => {
    const f = buildSummaryFormulas();
    expect(f.household[0][0]).toBe('=SUMIFS(FP_ACTUAL_INCOME_AMOUNT,FP_ACTUAL_INCOME_DATE,">="&DATEVALUE(FP_MONTH&"-01"),FP_ACTUAL_INCOME_DATE,"<"&EDATE(DATEVALUE(FP_MONTH&"-01"),1))');
    expect(f.categories[0][0]).toBe('=IF(A2="","",SUMIF(FP_BASELINE_CATEGORY,A2,FP_BASELINE_AMOUNT))');
    expect(f.categories[0][3]).toBe('=IF(A2="","",B2+C2-D2)');
    expect(f.categories[0][6]).toBe('=IF(A2="","",E2-F2-G2)');
    expect(f.household[1][0]).toContain("'Pendapatan Diharapkan'");
    expect(f.household[1][0]).toContain('"CONFIRMED"');
    expect(f.household[1][0]).toContain('DATEVALUE(FP_TODAY)');
    expect(f.categories[0][5]).toContain('"RESERVED"'); expect(f.categories[0][5]).toContain('"OVERRIDDEN"');
    expect(f.categories[0][1]).toContain('"ACTIVE"');
    expect(f.household[9][0]).toBe('=SUM(C2:C1001)-SUM(D2:D1001)');
    expect(f.categories).toHaveLength(1000);
    for (const row of [...f.categories, ...f.household]) for (const formula of row) {
      expect(formula).not.toMatch(/\b[A-Z]+:[A-Z]+\b/); expect(formula).not.toContain("IFERROR");
    }
  });
});
