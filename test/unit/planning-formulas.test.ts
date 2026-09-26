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
    expect(f.categories[0][0]).toBe('=IF(A2="","",SUMPRODUCT(N(EXACT(FP_BASELINE_CATEGORY,A2)),FP_BASELINE_AMOUNT))');
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
  it("emits literal case-sensitive identity predicates for every category-sensitive total", () => {
    const f = buildSummaryFormulas();
    const categoryFormulas = [f.categories[0][0], f.categories[0][1], f.categories[0][2], f.categories[0][4], f.categories[0][5]];
    const identityRanges = ["FP_BASELINE_CATEGORY", "'Transfer Budget'!$F$2:$F$1001", "'Transfer Budget'!$E$2:$E$1001", "FP_EXPENSE_CATEGORY", "'Rencana Pengeluaran'!$G$2:$G$1001"];
    for (let i = 0; i < categoryFormulas.length; i++) {
      expect(categoryFormulas[i]).toContain(`N(EXACT(${identityRanges[i]},A2))`);
      expect(categoryFormulas[i]).toContain("SUMPRODUCT(");
      expect(categoryFormulas[i]).not.toMatch(/SUMIFS?\(/);
    }
    expect(f.categories[0][1]).toContain('N(EXACT(\'Transfer Budget\'!$D$2:$D$1001,FP_MONTH))');
    expect(f.categories[0][1]).toContain('N(EXACT(\'Transfer Budget\'!$J$2:$J$1001,"ACTIVE"))');
    expect(f.categories[0][5]).toContain('N(EXACT(\'Rencana Pengeluaran\'!$D$2:$D$1001,FP_MONTH))');
    expect(f.categories[0][5]).toContain('N(EXACT(\'Rencana Pengeluaran\'!$J$2:$J$1001,"RESERVED"))');
    expect(f.categories[0][5]).toContain('N(EXACT(\'Rencana Pengeluaran\'!$J$2:$J$1001,"OVERRIDDEN"))');
    expect(f.household[1][0]).toContain('N(EXACT(\'Pendapatan Diharapkan\'!$H$2:$H$1001,"CONFIRMED"))');
    // Case-insensitive deduplication must not drop a distinct category before totals are computed.
    expect(f.categoryNames).toContain("EXACT(labels,INDEX(labels,i))");
    expect(f.categoryNames).not.toContain("UNIQUE(");
  });
  it("keeps wildcards, criterion operators, and differing case as distinct literal categories", () => {
    expect(aggregateBaseline([
      ["Food*", 100], ["Food*", 200], ["Food?", 400], ["Food", 800],
      ["food", 1600], [">Food", 3200], ["=Food", 6400], ["<>Food", 12800],
    ])).toEqual({ "Food*": 300, "Food?": 400, Food: 800, food: 1600, ">Food": 3200, "=Food": 6400, "<>Food": 12800 });
  });
});
