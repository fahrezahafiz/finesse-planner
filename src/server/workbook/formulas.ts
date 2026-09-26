import { DomainError } from "../../domain/errors";
import { parseMoney } from "../../domain/validation";
import { LAST_PLANNING_ROW, PLANNING_CAPACITY } from "./headers";
import type { SourceRange, WorkbookSourceMap } from "./source-map";

export const planningMath = {
  adjustedBudget: (baseline: number, transfersIn: number, transfersOut: number) => baseline + transfersIn - transfersOut,
  availableBudget: (adjusted: number, actual: number, reservations: number) => adjusted - actual - reservations,
  spendablePool: (actualIncome: number, futureIncome: number, savings: number) => actualIncome + futureIncome - savings,
  headroom: (pool: number, adjustedBudgets: number) => pool - adjustedBudgets,
};

export function aggregateBaseline(rows: readonly (readonly unknown[])[]): Record<string, number> {
  const result: Record<string, number> = Object.create(null);
  for (const [category, amount] of rows) {
    if (category === "" && amount === "") continue;
    if (typeof category !== "string" || !category.trim() || category.startsWith("#")) throw new DomainError("WORKBOOK_SCHEMA_INVALID");
    const next = (result[category] ?? 0) + parseMoney(amount);
    result[category] = parseMoney(next);
  }
  if (Object.keys(result).length === 0 || Object.keys(result).length > PLANNING_CAPACITY) throw new DomainError("WORKBOOK_SCHEMA_INVALID");
  return result;
}

export function sourceNamedRanges(map: WorkbookSourceMap): Record<string, SourceRange> {
  return {
    FP_BASELINE_CATEGORY: map.baseline.category, FP_BASELINE_AMOUNT: map.baseline.plannedAmount,
    FP_PLANNED_INCOME: map.savingsProfile.plannedIncome, FP_PLANNED_EXPENSES: map.savingsProfile.plannedExpenses,
    FP_PROTECTED_SAVINGS_SOURCE: map.savingsProfile.protectedMonthlySavings,
    FP_EXPENSE_DATE: map.expenseInput.date, FP_EXPENSE_CATEGORY: map.expenseInput.category,
    FP_EXPENSE_DETAIL: map.expenseInput.detail, FP_EXPENSE_ACCOUNT: map.expenseInput.account, FP_EXPENSE_AMOUNT: map.expenseInput.amount,
    FP_ACTUAL_INCOME_DATE: map.actualIncome.date, FP_ACTUAL_INCOME_AMOUNT: map.actualIncome.amount,
    FP_CASH_TRANSFER: map.cashTransfer, FP_ACCOUNT_NAMES: map.accounts.names, FP_ACCOUNT_BALANCES: map.accounts.currentBalances,
    FP_SOURCE_FRESHNESS: map.formulaFreshness,
  };
}

export const SUMMARY_NAMED_RANGES: Readonly<Record<string, string>> = {
  FP_CATEGORY: "A2:A1001", FP_BASELINE: "B2:B1001", FP_TRANSFERS_IN: "C2:C1001", FP_TRANSFERS_OUT: "D2:D1001",
  FP_ADJUSTED: "E2:E1001", FP_ACTUAL_SPENDING: "F2:F1001", FP_RESERVATIONS: "G2:G1001", FP_AVAILABLE: "H2:H1001",
  FP_ACTUAL_INCOME: "K1", FP_FUTURE_INCOME: "K2", FP_RECOGNIZED_INCOME: "K3", FP_PROTECTED_SAVINGS: "K4",
  FP_TOTAL_BASELINE: "K5", FP_TOTAL_ADJUSTED: "K6", FP_HEADROOM: "K7", FP_FUNDING: "K8",
  FP_RECONCILIATION_STATUS: "K9", FP_TRANSFER_RECONCILIATION: "K10", FP_MONTH: "K11", FP_TODAY: "K12",
};

export function buildSummaryFormulas() {
  const end = LAST_PLANNING_ROW;
  const ledger = (name: string, col: string) => `'${name}'!$${col}$2:$${col}$${end}`;
  const t = (col: string) => ledger("Transfer Budget", col);
  const p = (col: string) => ledger("Rencana Pengeluaran", col);
  const income = (col: string) => ledger("Pendapatan Diharapkan", col);
  const start = 'DATEVALUE(FP_MONTH&"-01")';
  const monthDates = (range: string) => `${range},">="&${start},${range},"<"&EDATE(${start},1)`;
  // EXACT treats category/status/month text as case-sensitive identities, never
  // as SUMIF criterion expressions or wildcard patterns.
  const exact = (range: string, value: string) => `N(EXACT(${range},${value}))`;
  const sum = (amount: string, ...predicates: string[]) => `SUMPRODUCT(${[...predicates, amount].join(",")})`;
  const currentMonthDates = (range: string) => [`N(${range}>=${start})`, `N(${range}<EDATE(${start},1))`];
  const categories = Array.from({ length: PLANNING_CAPACITY }, (_, i) => {
    const r = i + 2;
    const present = (formula: string) => `=IF(A${r}="","",${formula})`;
    return [
      present(sum("FP_BASELINE_AMOUNT", exact("FP_BASELINE_CATEGORY", `A${r}`))),
      present(sum(t("G"), exact(t("F"), `A${r}`), exact(t("D"), "FP_MONTH"), exact(t("J"), '"ACTIVE"'))),
      present(sum(t("G"), exact(t("E"), `A${r}`), exact(t("D"), "FP_MONTH"), exact(t("J"), '"ACTIVE"'))),
      present(`B${r}+C${r}-D${r}`),
      present(sum("FP_EXPENSE_AMOUNT", exact("FP_EXPENSE_CATEGORY", `A${r}`), ...currentMonthDates("FP_EXPENSE_DATE"))),
      present(["RESERVED", "OVERRIDDEN"].map(status => sum(p("I"), exact(p("G"), `A${r}`), exact(p("D"), "FP_MONTH"), exact(p("J"), `"${status}"`))).join("+")),
      present(`E${r}-F${r}-G${r}`),
    ];
  });
  const household = [
    `=SUMIFS(FP_ACTUAL_INCOME_AMOUNT,${monthDates("FP_ACTUAL_INCOME_DATE")})`,
    `=${sum(income("G"), exact(income("H"), '"CONFIRMED"'), `N(${income("D")}>=DATEVALUE(FP_TODAY))`, `N(${income("D")}<EDATE(${start},1))`)}`,
    "=K1+K2", "=FP_PROTECTED_SAVINGS_SOURCE", `=SUM(B2:B${end})`, `=SUM(E2:E${end})`,
    "=K1+K2-K4-K6", "=K7",
    '=IF(AND(COUNT(K1:K8)=8,K10=0,K7>=0,COUNT(FP_BASELINE_AMOUNT)=COUNTIF(FP_BASELINE_CATEGORY,"<>"),COUNT(FP_ACTUAL_INCOME_AMOUNT)=COUNTA(FP_ACTUAL_INCOME_DATE),COUNT(FP_ACCOUNT_BALANCES)=COUNTIF(FP_ACCOUNT_NAMES,"<>")),"HEALTHY","INVALID")',
    `=SUM(C2:C${end})-SUM(D2:D${end})`, '=TEXT(TODAY(),"yyyy-mm")', '=TEXT(TODAY(),"yyyy-mm-dd")',
  ].map(formula => [formula]);
  return {
    categoryNames: '=LET(labels,FILTER(FP_BASELINE_CATEGORY,FP_BASELINE_CATEGORY<>""),SORT(FILTER(labels,MAP(SEQUENCE(ROWS(labels)),LAMBDA(i,SUMPRODUCT(N(EXACT(labels,INDEX(labels,i))),N(SEQUENCE(ROWS(labels))<=i))=1)))))',
    categories, household,
  };
}
