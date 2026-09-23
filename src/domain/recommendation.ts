import type { Decision, GuardrailResult, Money, PlanningHealth, PlanningSnapshot, Proposal } from "./types";

type GuardrailName =
  | "PLANNING_MONTH_HEALTH"
  | "CATEGORY_AVAILABILITY"
  | "PROTECTED_SAVINGS"
  | "ACCOUNT_LIQUIDITY"
  | "SCHEMA_AND_FORMULA_HEALTH";

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE = -MAX_SAFE;
const passed: GuardrailResult = { passed: true, shortfall: 0 };
const failed = (shortfall: number): GuardrailResult => ({ passed: false, shortfall });

/** Evaluates each guardrail after health and proposal gates; unsafe input never enters financial arithmetic. */
export function evaluatePurchase(snapshot: PlanningSnapshot, proposal: Proposal): Decision {
  if (snapshot.health !== "HEALTHY" || !hasUsableSnapshotData(snapshot) || !hasUsableProposal(proposal)) {
    return unavailableDecision(snapshot.health);
  }
  try {
    const category = snapshot.categories[proposal.category];
    const amount = exact(proposal.amount);
    const categoryAvailable = category ? exact(category.availableBudget) : 0n;
    const categoryResult = category ? resultFor(categoryAvailable - amount) : failed(proposal.amount);
    const overage = category ? maximum(0n, amount - categoryAvailable) : amount;
    const projectedSavings = exact(snapshot.actualIncome) + exact(snapshot.confirmedFutureIncome)
      - exact(snapshot.totalAdjustedBudgets) - overage;
    const savingsResult = resultFor(projectedSavings - exact(snapshot.protectedSavingsTarget));
    const householdResult = resultFor(exact(snapshot.unallocatedHeadroom) - overage);
    const accountResult = accountGuardrail(snapshot, proposal);
    const safeDailyAllowance = dailyAllowance(snapshot, amount);
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
  } catch {
    return unavailableDecision("WORKBOOK_SCHEMA_INVALID");
  }
}

/** Liquidity immediately before the proposed charge, using literal account names and inclusive dates. */
export function plannedAccountLiquidity(snapshot: PlanningSnapshot, proposal: Proposal): number | null {
  if (snapshot.health !== "HEALTHY" || !hasUsableSnapshotData(snapshot) || !hasUsableProposal(proposal)) return null;
  try {
    const liquidity = accountLiquidity(snapshot, proposal);
    return liquidity === null ? null : safeNumber(liquidity);
  } catch {
    return null;
  }
}

function accountGuardrail(snapshot: PlanningSnapshot, proposal: Proposal): GuardrailResult {
  const liquidity = accountLiquidity(snapshot, proposal);
  return liquidity === null ? failed(proposal.amount) : resultFor(liquidity - exact(proposal.amount));
}

function accountLiquidity(snapshot: PlanningSnapshot, proposal: Proposal): bigint | null {
  const account = snapshot.accounts[proposal.paymentAccount];
  if (!account) return null;
  const income = snapshot.confirmedIncome
    .filter(entry => entry.destinationAccount === proposal.paymentAccount && entry.expectedDate <= proposal.plannedDate)
    .reduce((sum, entry) => sum + exact(entry.amount), 0n);
  const reservations = snapshot.activeReservations
    .filter(entry => entry.paymentAccount === proposal.paymentAccount && entry.plannedDate <= proposal.plannedDate)
    .reduce((sum, entry) => sum + exact(entry.amount), 0n);
  return exact(account.currentBalance) + income - reservations;
}

function dailyAllowance(snapshot: PlanningSnapshot, amount: bigint): Money {
  if (snapshot.daysRemainingInclusive <= 0) return 0 as Money;
  const available = Object.values(snapshot.categories).reduce((sum, category) => sum + exact(category.availableBudget), 0n);
  const afterPurchase = available - amount;
  return safeNumber(maximum(0n, afterPurchase) / exact(snapshot.daysRemainingInclusive)) as Money;
}

function resultFor(remaining: bigint): GuardrailResult {
  return remaining >= 0n ? passed : failed(safeNumber(-remaining));
}

function maximum(left: bigint, right: bigint): bigint { return left >= right ? left : right; }
function exact(value: number): bigint { return BigInt(value); }
function safeNumber(value: bigint): number {
  if (value < MIN_SAFE || value > MAX_SAFE) throw new Error("UNSAFE_MONEY_RESULT");
  return Number(value);
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

function hasUsableProposal(proposal: Proposal): boolean {
  return typeof proposal?.amount === "number" && Number.isSafeInteger(proposal.amount) && proposal.amount > 0;
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
