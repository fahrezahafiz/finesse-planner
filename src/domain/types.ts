export type Money = number & { readonly __money: unique symbol };
export type LocalDate = string & { readonly __localDate: unique symbol };
export type YearMonth = string & { readonly __yearMonth: unique symbol };

export type Verdict =
  | "RECOMMENDED"
  | "NOT_RECOMMENDED"
  | "UNABLE_TO_EVALUATE";

export type PlanStatus =
  | "RESERVED"
  | "OVERRIDDEN"
  | "COMPLETED"
  | "CANCELLED"
  | "EXPIRED";

export interface Proposal {
  actionId: string;
  item: string;
  amount: Money;
  category: string;
  plannedDate: LocalDate;
  paymentAccount: string;
}

export type PlanningHealth =
  | "HEALTHY"
  | "FORMULA_ERROR"
  | "STALE_PLANNING_MONTH"
  | "TRANSFER_RECONCILIATION_ERROR"
  | "UNDERFUNDED"
  | "WORKBOOK_SCHEMA_INVALID";

export interface CategoryPlanningSnapshot {
  baselineBudget: Money;
  transfersIn: Money;
  transfersOut: Money;
  adjustedBudget: Money;
  actualSpending: Money;
  activeReservations: Money;
  availableBudget: number;
}

export interface AccountPlanningSnapshot {
  currentBalance: Money;
}

export interface PlanningSnapshot {
  month: YearMonth;
  health: PlanningHealth;
  actualIncome: Money;
  confirmedFutureIncome: Money;
  protectedSavingsTarget: Money;
  totalAdjustedBudgets: Money;
  unallocatedHeadroom: number;
  categories: Readonly<Record<string, CategoryPlanningSnapshot>>;
  accounts: Readonly<Record<string, AccountPlanningSnapshot>>;
}

export interface GuardrailResult {
  passed: boolean;
  shortfall: number;
}

export interface Decision {
  verdict: Verdict;
  category: GuardrailResult;
  savings: GuardrailResult;
  household: GuardrailResult;
  account: GuardrailResult;
  safeDailyAllowance: Money;
  failedGuardrails: readonly string[];
  firstFailure: string | null;
}
