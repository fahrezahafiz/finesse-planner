export interface HeaderAnchor {
  readonly sheet: string;
  readonly a1: string;
  readonly label: string;
}

export interface SourceRange {
  readonly sheet: string;
  readonly a1: string;
  /** The exact, uniquely observed label that authorizes this range. */
  readonly header: Omit<HeaderAnchor, "sheet">;
}

/**
 * The workbook source map is supplied only after a redacted audit of a
 * development copy. There is deliberately no built-in map: using an
 * uncalibrated range against a household workbook must fail closed.
 */
export interface WorkbookSourceMap {
  readonly calibration: {
    readonly source: "development-copy-audit";
    readonly auditedAt: string;
  };
  readonly baseline: {
    readonly category: SourceRange;
    readonly plannedAmount: SourceRange;
  };
  readonly savingsProfile: {
    readonly plannedIncome: SourceRange;
    readonly plannedExpenses: SourceRange;
    readonly protectedMonthlySavings: SourceRange;
  };
  readonly expenseInput: {
    readonly date: SourceRange;
    readonly category: SourceRange;
    readonly detail: SourceRange;
    readonly account: SourceRange;
    readonly amount: SourceRange;
  };
  readonly actualIncome: SourceRange;
  readonly cashTransfer: SourceRange;
  readonly accounts: {
    readonly names: SourceRange;
    readonly currentBalances: SourceRange;
  };
  readonly formulaFreshness: SourceRange;
  readonly timeZone: string;
}

export const REQUIRED_EXISTING_SHEETS = [
  "Atur Budgeting",
  "Profil Kemampuan Menabung",
  "Catat - Pendapatan",
  "Catat - Pengeluaran",
  "Catat - Pindah Kas/Nabung",
  "backend",
] as const;

export function sourceMapRanges(sourceMap: WorkbookSourceMap): readonly SourceRange[] {
  return [
    sourceMap.baseline.category,
    sourceMap.baseline.plannedAmount,
    sourceMap.savingsProfile.plannedIncome,
    sourceMap.savingsProfile.plannedExpenses,
    sourceMap.savingsProfile.protectedMonthlySavings,
    sourceMap.expenseInput.date,
    sourceMap.expenseInput.category,
    sourceMap.expenseInput.detail,
    sourceMap.expenseInput.account,
    sourceMap.expenseInput.amount,
    sourceMap.actualIncome,
    sourceMap.cashTransfer,
    sourceMap.accounts.names,
    sourceMap.accounts.currentBalances,
    sourceMap.formulaFreshness,
  ];
}

export function sourceMapAnchors(sourceMap: WorkbookSourceMap): readonly HeaderAnchor[] {
  return sourceMapRanges(sourceMap).map(range => ({
    sheet: range.sheet,
    a1: range.header.a1,
    label: range.header.label,
  }));
}
