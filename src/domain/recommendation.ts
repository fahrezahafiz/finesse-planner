import type { Decision, GuardrailResult, Money, PlanningHealth, PlanningSnapshot, Proposal } from "./types";

type GuardrailName =
  | "PLANNING_MONTH_HEALTH"
  | "CATEGORY_AVAILABILITY"
  | "PROTECTED_SAVINGS"
  | "ACCOUNT_LIQUIDITY"
  | "SCHEMA_AND_FORMULA_HEALTH";

const passed: GuardrailResult = { passed: true, shortfall: 0 };
const failed = (shortfall: number): GuardrailResult => ({ passed: false, shortfall: Math.max(0, shortfall) });

/** Evaluates each guardrail after a health gate; invalid snapshots never enter financial arithmetic. */
export function evaluatePurchase(snapshot: PlanningSnapshot, proposal: Proposal): Decision {
  if (snapshot.health !== "HEALTHY" || !hasUsableSnapshotData(snapshot)) return unavailableDecision(snapshot.health);

  const category = snapshot.categories[proposal.category];
  const categoryResult = category
    ? resultFor(category.availableBudget - proposal.amount)
    : failed(proposal.amount);
  const overage = category ? Math.max(0, proposal.amount - category.availableBudget) : proposal.amount;
  const projectedSavings = snapshot.actualIncome + snapshot.confirmedFutureIncome - snapshot.totalAdjustedBudgets - overage;
  const savingsResult = resultFor(projectedSavings - snapshot.protectedSavingsTarget);
  const householdResult = resultFor(snapshot.unallocatedHeadroom - overage);
  const accountResult = accountGuardrail(snapshot, proposal);
  const safeDailyAllowance = dailyAllowance(snapshot, proposal.amount);
  const checks: readonly [GuardrailName, GuardrailResult][] = [
    ["PLANNING_MONTH_HEALTH", passed],
    ["CATEGORY_AVAILABILITY", categoryResult],
    ["PROTECTED_SAVINGS", savingsResult],
    ["ACCOUNT_LIQUIDITY", accountResult],
    ["SCHEMA_AND_FORMULA_HEALTH", passed],
  ];
  const failedGuardrails = checks.filter(([, result]) => !result.passed).map(([name]) => name);
  return {
    verdict: failedGuardrails.length ? "NOT_RECOMMENDED" : "RECOMMENDED",
    category: categoryResult, savings: savingsResult, household: householdResult, account: accountResult,
    safeDailyAllowance, failedGuardrails, firstFailure: failedGuardrails[0] ?? null,
  };
}

/** Liquidity immediately before the proposed charge, using literal account names and inclusive dates. */
export function plannedAccountLiquidity(snapshot: PlanningSnapshot, proposal: Proposal): number | null {
  const account = snapshot.accounts[proposal.paymentAccount];
  if (!account) return null;
  const income = snapshot.confirmedIncome
    .filter(entry => entry.destinationAccount === proposal.paymentAccount && entry.expectedDate <= proposal.plannedDate)
    .reduce((sum, entry) => sum + entry.amount, 0);
  const reservations = snapshot.activeReservations
    .filter(entry => entry.paymentAccount === proposal.paymentAccount && entry.plannedDate <= proposal.plannedDate)
    .reduce((sum, entry) => sum + entry.amount, 0);
  return account.currentBalance + income - reservations;
}

function accountGuardrail(snapshot: PlanningSnapshot, proposal: Proposal): GuardrailResult {
  const liquidity = plannedAccountLiquidity(snapshot, proposal);
  return liquidity === null ? failed(proposal.amount) : resultFor(liquidity - proposal.amount);
}

function dailyAllowance(snapshot: PlanningSnapshot, amount: Money): Money {
  if (snapshot.daysRemainingInclusive <= 0) return 0 as Money;
  const available = Object.values(snapshot.categories).reduce((sum, category) => sum + category.availableBudget, 0);
  return Math.max(0, Math.floor((available - amount) / snapshot.daysRemainingInclusive)) as Money;
}

function resultFor(remaining: number): GuardrailResult {
  return remaining >= 0 ? passed : failed(-remaining);
}

function unavailableDecision(health: PlanningHealth): Decision {
  const planningFailure = health === "UNDERFUNDED" || health === "STALE_PLANNING_MONTH" || health === "TRANSFER_RECONCILIATION_ERROR";
  const schemaFailure = !planningFailure;
  const planning = planningFailure ? failed(0) : passed;
  const schema = schemaFailure ? failed(0) : passed;
  const checks: readonly [GuardrailName, GuardrailResult][] = [
    ["PLANNING_MONTH_HEALTH", planning],
    ["SCHEMA_AND_FORMULA_HEALTH", schema],
  ];
  const failedGuardrails = checks.filter(([, result]) => !result.passed).map(([name]) => name);
  return { verdict: "UNABLE_TO_EVALUATE", category: passed, savings: passed, household: planning, account: passed, safeDailyAllowance: 0 as Money, failedGuardrails, firstFailure: failedGuardrails[0] ?? null };
}

function hasUsableSnapshotData(snapshot: PlanningSnapshot): boolean {
  const money = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  if (!money(snapshot.actualIncome) || !money(snapshot.confirmedFutureIncome) || !money(snapshot.protectedSavingsTarget)
    || !money(snapshot.totalAdjustedBudgets) || !Number.isSafeInteger(snapshot.unallocatedHeadroom)
    || !Number.isSafeInteger(snapshot.daysRemainingInclusive) || snapshot.daysRemainingInclusive < 0) return false;
  return Object.values(snapshot.categories).every(category => Number.isSafeInteger(category.availableBudget))
    && Object.values(snapshot.accounts).every(account => money(account.currentBalance))
    && snapshot.confirmedIncome.every(income => money(income.amount))
    && snapshot.activeReservations.every(reservation => money(reservation.amount));
}
