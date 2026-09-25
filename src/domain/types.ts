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

/** A confirmed current-month income that can affect account liquidity. */
export interface ConfirmedIncomeSnapshot {
  amount: Money;
  destinationAccount: string;
  expectedDate: LocalDate;
}

/** An active plan that reserves the named account through its planned date. */
export interface ActiveReservationSnapshot {
  actionId: string;
  item?: string;
  category?: string;
  amount: Money;
  paymentAccount: string;
  plannedDate: LocalDate;
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
  planningDate: LocalDate;
  daysRemainingInclusive: number;
  confirmedIncome: readonly ConfirmedIncomeSnapshot[];
  activeReservations: readonly ActiveReservationSnapshot[];
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

export type Correction =
  | { kind: "LOWER_PRICE"; amount: Money }
  | { kind: "TRANSFER"; fromCategory: string; toCategory: string; amount: Money }
  | { kind: "ALTERNATE_ACCOUNT"; paymentAccount: string }
  | { kind: "WAIT_FOR_INCOME"; expectedDate: LocalDate };
