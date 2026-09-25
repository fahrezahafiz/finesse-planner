import type { Plan } from "../domain/plans";
import type { Transfer } from "../domain/transfers";
import type { ExpectedIncome } from "../domain/expected-income";
import type {
  BaselineChangeSuggestion,
  BaselineReviewProposal,
  RecurringCategoryPattern,
  TransferPatternAnalysis,
} from "../domain/insights";
import type { Correction, Decision, GuardrailResult, PlanningHealth, PlanningSnapshot } from "../domain/types";
import type { AppliedBaselineChange, BaselineReviewResult } from "./services/baseline-review-service";

/**
 * Pure view-model layer: every function here only reshapes already-fetched domain data into
 * client-safe response DTOs. Nothing in this file touches the workbook, auth, or any live
 * Apps Script service, and nothing here ever serializes a WorkbookSourceMap, a repository row,
 * or anything else shaped like a sheet name, range, or formula.
 */

export interface CategoryBudgetView {
  readonly category: string;
  readonly adjustedBudget: number;
  readonly availableBudget: number;
}

export interface AccountBalanceView {
  readonly account: string;
  readonly currentBalance: number;
}

export interface ActiveReservationView {
  readonly actionId: string;
  readonly item?: string;
  readonly category?: string;
  readonly amount: number;
  readonly paymentAccount: string;
  readonly plannedDate: string;
}

/**
 * The client's "first viewport": protected savings, funded amount, safe-to-plan amount, days
 * remaining, and active reservations, plus enough category/account detail to render budget
 * progress without the client doing its own optimistic financial arithmetic.
 */
export interface PlanningStateView {
  readonly month: string;
  readonly health: PlanningHealth;
  readonly planningDate: string;
  readonly daysRemaining: number;
  readonly protectedSavings: number;
  /** Total recognized monthly income (actual + confirmed future income) funding this month's plan. */
  readonly fundedAmount: number;
  /** The unallocated headroom: how much more can safely be planned this month. */
  readonly safeToPlanAmount: number;
  readonly categories: readonly CategoryBudgetView[];
  readonly accounts: readonly AccountBalanceView[];
  readonly activeReservations: readonly ActiveReservationView[];
  readonly activeTransfers?: readonly TransferView[];
  readonly activeIncome?: readonly IncomeView[];
}

export function toPlanningStateView(snapshot: PlanningSnapshot): PlanningStateView {
  return {
    month: snapshot.month,
    health: snapshot.health,
    planningDate: snapshot.planningDate,
    daysRemaining: snapshot.daysRemainingInclusive,
    protectedSavings: snapshot.protectedSavingsTarget,
    fundedAmount: snapshot.actualIncome + snapshot.confirmedFutureIncome,
    safeToPlanAmount: snapshot.unallocatedHeadroom,
    categories: Object.entries(snapshot.categories).map(([category, value]) => ({
      category,
      adjustedBudget: value.adjustedBudget,
      availableBudget: value.availableBudget,
    })),
    accounts: Object.entries(snapshot.accounts).map(([account, value]) => ({
      account,
      currentBalance: value.currentBalance,
    })),
    activeReservations: snapshot.activeReservations.map(reservation => ({
      actionId: reservation.actionId,
      item: reservation.item,
      category: reservation.category,
      amount: reservation.amount,
      paymentAccount: reservation.paymentAccount,
      plannedDate: reservation.plannedDate,
    })),
  };
}

export interface PlanView {
  readonly actionId: string;
  readonly item: string;
  readonly category: string;
  readonly paymentAccount: string;
  readonly amount: number;
  readonly plannedDate: string;
  readonly status: Plan["status"];
  readonly verdict: Plan["verdict"];
  readonly failedGuardrails: readonly string[];
  readonly overrideReason: string;
  readonly createdAt: string;
  readonly completedAt: string | null;
}

export function toPlanView(plan: Plan): PlanView {
  return {
    actionId: plan.actionId,
    item: plan.item,
    category: plan.category,
    paymentAccount: plan.paymentAccount,
    amount: plan.amount,
    plannedDate: plan.plannedDate,
    status: plan.status,
    verdict: plan.verdict,
    failedGuardrails: plan.failedGuardrails,
    overrideReason: plan.overrideReason,
    createdAt: plan.createdAt,
    completedAt: plan.completedAt,
  };
}

export interface TransferView {
  readonly actionId: string;
  readonly month: string;
  readonly createdBy: string;
  readonly fromCategory: string;
  readonly toCategory: string;
  readonly amount: number;
  readonly reason: string;
  readonly relatedPlanId: string;
  readonly status: Transfer["status"];
  readonly createdAt: string;
  readonly reversalReference: string;
}

export function toTransferView(transfer: Transfer): TransferView {
  return {
    actionId: transfer.actionId,
    month: transfer.month,
    createdBy: transfer.createdBy,
    fromCategory: transfer.fromCategory,
    toCategory: transfer.toCategory,
    amount: transfer.amount,
    reason: transfer.reason,
    relatedPlanId: transfer.relatedPlanId,
    status: transfer.status,
    createdAt: transfer.createdAt,
    reversalReference: transfer.reversalReference,
  };
}

export interface IncomeView {
  readonly actionId: string;
  readonly expectedDate: string;
  readonly source: string;
  readonly destinationAccount: string;
  readonly amount: number;
  readonly note: string;
  readonly status: ExpectedIncome["status"];
  readonly createdAt: string;
}

export function toIncomeView(income: ExpectedIncome): IncomeView {
  return {
    actionId: income.actionId,
    expectedDate: income.expectedDate,
    source: income.source,
    destinationAccount: income.destinationAccount,
    amount: income.amount,
    note: income.note,
    status: income.status,
    createdAt: income.createdAt,
  };
}

export interface GuardrailComparisonView {
  readonly passed: boolean;
  readonly shortfall: number;
}

export interface DecisionView {
  readonly verdict: Decision["verdict"];
  readonly category: GuardrailComparisonView;
  readonly savings: GuardrailComparisonView;
  readonly household: GuardrailComparisonView;
  readonly account: GuardrailComparisonView;
  readonly safeDailyAllowance: number;
  readonly failedGuardrails: readonly string[];
  readonly firstFailure: string | null;
}

export function toDecisionView(decision: Decision): DecisionView {
  const comparison = (result: GuardrailResult): GuardrailComparisonView => ({ passed: result.passed, shortfall: result.shortfall });
  return {
    verdict: decision.verdict,
    category: comparison(decision.category),
    savings: comparison(decision.savings),
    household: comparison(decision.household),
    account: comparison(decision.account),
    safeDailyAllowance: decision.safeDailyAllowance,
    failedGuardrails: decision.failedGuardrails,
    firstFailure: decision.firstFailure,
  };
}

export type CorrectionView = Correction;

export function toCorrectionView(correction: Correction): CorrectionView {
  return correction;
}

export interface RecurringCategoryPatternView {
  readonly category: string;
  readonly frequency: number;
  readonly total: number;
  readonly averageMonthlyNet: number;
}

function toPatternView(pattern: RecurringCategoryPattern): RecurringCategoryPatternView {
  return { category: pattern.category, frequency: pattern.frequency, total: pattern.total, averageMonthlyNet: pattern.averageMonthlyNet };
}

export interface TransferPatternAnalysisView {
  readonly windowMonths: readonly string[];
  readonly recurringRecipients: readonly RecurringCategoryPatternView[];
  readonly recurringDonors: readonly RecurringCategoryPatternView[];
}

export function toTransferPatternView(analysis: TransferPatternAnalysis): TransferPatternAnalysisView {
  return {
    windowMonths: analysis.windowMonths,
    recurringRecipients: analysis.recurringRecipients.map(toPatternView),
    recurringDonors: analysis.recurringDonors.map(toPatternView),
  };
}

export interface BaselineChangeSuggestionView {
  readonly category: string;
  readonly direction: BaselineChangeSuggestion["direction"];
  readonly amount: number;
  readonly frequency: number;
  readonly averageMonthlyNet: number;
}

export interface BaselineReviewProposalView {
  readonly windowMonths: readonly string[];
  readonly changes: readonly BaselineChangeSuggestionView[];
}

export function toBaselineReviewProposalView(proposal: BaselineReviewProposal): BaselineReviewProposalView {
  return {
    windowMonths: proposal.windowMonths,
    changes: proposal.changes.map(change => ({
      category: change.category,
      direction: change.direction,
      amount: change.amount,
      frequency: change.frequency,
      averageMonthlyNet: change.averageMonthlyNet,
    })),
  };
}

export interface AppliedBaselineChangeView {
  readonly category: string;
  readonly previousAmount: number;
  readonly newAmount: number;
}

export interface BaselineReviewResultView {
  readonly appliedAt: string;
  readonly appliedBy: string;
  readonly reason: string;
  readonly changes: readonly AppliedBaselineChangeView[];
}

function toAppliedBaselineChangeView(change: AppliedBaselineChange): AppliedBaselineChangeView {
  return { category: change.category, previousAmount: change.previousAmount, newAmount: change.newAmount };
}

export function toBaselineReviewResultView(result: BaselineReviewResult): BaselineReviewResultView {
  return {
    appliedAt: result.appliedAt,
    appliedBy: result.appliedBy,
    reason: result.reason,
    changes: result.changes.map(toAppliedBaselineChangeView),
  };
}

export interface HistoryView {
  readonly plans: readonly PlanView[];
  readonly transfers: readonly TransferView[];
  readonly income: readonly IncomeView[];
}

export interface InsightsView {
  readonly transferPatterns: TransferPatternAnalysisView;
  readonly baselineReview: BaselineReviewProposalView;
}

/** Shared shape for every mutation endpoint's response: an actionId plus refreshed planning state. */
export interface MutationResultView<T> {
  readonly actionId: string;
  readonly result: T;
  readonly planningState: PlanningStateView;
}

export interface PurchaseCheckView {
  readonly decision: DecisionView;
  readonly corrections: readonly CorrectionView[];
  readonly comparison?: {
    readonly categoryWithout: number;
    readonly categoryWith: number;
    readonly savingsWithout: number;
    readonly savingsWith: number;
    readonly householdWithout: number;
    readonly householdWith: number;
    readonly accountWithout: number;
    readonly accountWith: number;
  };
}
