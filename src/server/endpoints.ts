import { DomainError } from "../domain/errors";
import { inputObject, parseActionId, parseOverrideReason, parseProposal } from "../domain/plans";
import { parseTransferProposal } from "../domain/transfers";
import { parseExpectedIncomeProposal } from "../domain/expected-income";
import { parseApprovedBaselineChange } from "../domain/insights";
import { suggestCorrections } from "../domain/corrections";
import type { RequestClock } from "../domain/time";
import type { Proposal } from "../domain/types";
import type { AuthContext } from "./auth";
import type { ServerDeps } from "./deps";
import type { DocumentLock } from "./lock";
import { secureRpc, type RpcRuntime } from "./rpc";
import type { WorkbookSourceMap } from "./workbook/source-map";
import { readPlanningSnapshot } from "./workbook/snapshot-reader";
import { PlanRepository } from "./workbook/plan-repository";
import { TransferRepository } from "./workbook/transfer-repository";
import { IncomeRepository } from "./workbook/income-repository";
import { checkPurchase, reservePurchase, overridePurchase, cancelPlan, expirePastPlans } from "./services/plan-service";
import { completePlan } from "./services/completion-service";
import { createTransfer, reverseTransfer } from "./services/transfer-service";
import { createExpectedIncome, markIncomeReceived, cancelExpectedIncome } from "./services/income-service";
import { getTransferPatternInsights, reviewBaselineChangeSuggestions } from "./services/insight-service";
import { applyApprovedBaselineChange } from "./services/baseline-review-service";
import {
  toBaselineReviewProposalView,
  toBaselineReviewResultView,
  toCorrectionView,
  toDecisionView,
  toIncomeView,
  toPlanningStateView,
  toPlanView,
  toTransferPatternView,
  toTransferView,
  type HistoryView,
  type InsightsView,
  type MutationResultView,
  type PlanningStateView,
  type PurchaseCheckView,
} from "./view-models";

const TERMINAL_PLAN_STATUSES = new Set(["COMPLETED", "CANCELLED", "EXPIRED"]);
const TERMINAL_INCOME_STATUSES = new Set(["RECEIVED", "CANCELLED"]);
const INCOME_UPDATE_STATUSES = new Set(["RECEIVED", "CANCELLED"]);

/** The common shape every write-capable *ServiceDeps interface from Tasks 7-10 requires. */
interface WritableServiceDeps {
  auth: AuthContext;
  clock: RequestClock;
  sourceMap: WorkbookSourceMap;
  lock: DocumentLock | null;
}

/**
 * Composes the secure RPC boundary's ServerDeps into the shape every mutation/read service from
 * Tasks 7-10 expects. sourceMap is cast through as-is per the ruling in deps.ts: it may be
 * undefined at runtime even though the service interfaces declare it required, and
 * validateWorkbookSchema (already reviewed, already fails closed) is what actually enforces a
 * calibrated map before any read or write proceeds.
 */
function writableDeps(auth: AuthContext, deps: ServerDeps): WritableServiceDeps {
  return {
    auth,
    clock: requestClock(deps),
    sourceMap: deps.sourceMap as WorkbookSourceMap,
    lock: deps.lock ?? null,
  };
}

function requestClock(deps: ServerDeps): RequestClock {
  // secureRpc always attaches a requestClock before invoking the handler.
  return deps.requestClock as RequestClock;
}

function refreshedPlanningState(auth: AuthContext, deps: ServerDeps): PlanningStateView {
  const snapshot = readPlanningSnapshot(auth, requestClock(deps), deps.sourceMap as WorkbookSourceMap | undefined);
  return toPlanningStateView(snapshot);
}

function mutationResult<T>(actionId: string, result: T, auth: AuthContext, deps: ServerDeps): MutationResultView<T> {
  return { actionId, result, planningState: refreshedPlanningState(auth, deps) };
}

/** Accepts no meaningful payload: undefined, null, or any plain object, all ignored. */
function parseEmptyCommand(value: unknown): Record<string, never> {
  if (value !== undefined && value !== null && (typeof value !== "object" || Array.isArray(value))) {
    throw new DomainError("INVALID_INPUT");
  }
  return {};
}

function parseActionIdCommand(value: unknown): { actionId: string } {
  return { actionId: parseActionId(inputObject(value).actionId) };
}

function parseOverrideCommand(value: unknown): Proposal & { reason: string } {
  const proposal = parseProposal(value);
  const reason = parseOverrideReason(inputObject(value).reason);
  return { ...proposal, reason };
}

function parseReverseTransferCommand(value: unknown): { actionId: string; transferId: string } {
  const input = inputObject(value);
  return { actionId: parseActionId(input.actionId), transferId: parseActionId(input.transferId) };
}

type IncomeUpdateStatus = "RECEIVED" | "CANCELLED";

function parseUpdateIncomeCommand(value: unknown): { actionId: string; status: IncomeUpdateStatus } {
  const input = inputObject(value);
  const actionId = parseActionId(input.actionId);
  if (typeof input.status !== "string" || !INCOME_UPDATE_STATUSES.has(input.status)) throw new DomainError("INVALID_INPUT");
  return { actionId, status: input.status as IncomeUpdateStatus };
}

/**
 * A page load is a natural point to roll over stale reservations before showing state, so
 * getBootstrap always expires past plans first. expirePastPlans only validates its actionId's
 * shape (the rollover itself is not keyed to it), so a deterministic per-day value is enough.
 */
function rolloverActionId(clock: RequestClock): string {
  return `bootstrap-${clock.today}`;
}

/**
 * Builds all 13 secured RPC endpoints. `runtime` lets tests inject a fake ServerDeps the same
 * way src/server/rpc.ts's own tests do; production callers (main.ts) use the zero-argument form,
 * which defaults every endpoint to appsScriptDeps().
 */
export function createEndpoints(runtime?: RpcRuntime) {
  const getBootstrap = secureRpc(parseEmptyCommand, (_input, auth, deps): PlanningStateView => {
    expirePastPlans({ actionId: rolloverActionId(requestClock(deps)) }, writableDeps(auth, deps));
    return refreshedPlanningState(auth, deps);
  }, runtime);

  const checkPurchaseRpc = secureRpc(parseProposal, (proposal, auth, deps): PurchaseCheckView => {
    const decision = checkPurchase(proposal, writableDeps(auth, deps));
    const snapshot = readPlanningSnapshot(auth, requestClock(deps), deps.sourceMap as WorkbookSourceMap | undefined);
    const corrections = suggestCorrections(snapshot, proposal, decision);
    return { decision: toDecisionView(decision), corrections: corrections.map(toCorrectionView) };
  }, runtime);

  const reservePurchaseRpc = secureRpc(parseProposal, (proposal, auth, deps) => {
    const plan = reservePurchase(proposal, writableDeps(auth, deps));
    return mutationResult(plan.actionId, toPlanView(plan), auth, deps);
  }, runtime);

  const overridePurchaseRpc = secureRpc(parseOverrideCommand, (command, auth, deps) => {
    const plan = overridePurchase(command, writableDeps(auth, deps));
    return mutationResult(plan.actionId, toPlanView(plan), auth, deps);
  }, runtime);

  const cancelPlanRpc = secureRpc(parseActionIdCommand, (command, auth, deps) => {
    const plan = cancelPlan(command, writableDeps(auth, deps));
    return mutationResult(plan.actionId, toPlanView(plan), auth, deps);
  }, runtime);

  const completePlanRpc = secureRpc(parseActionIdCommand, (command, auth, deps) => {
    const plan = completePlan(command, writableDeps(auth, deps));
    return mutationResult(plan.actionId, toPlanView(plan), auth, deps);
  }, runtime);

  const createTransferRpc = secureRpc(parseTransferProposal, (proposal, auth, deps) => {
    const transfer = createTransfer(proposal, writableDeps(auth, deps));
    return mutationResult(transfer.actionId, toTransferView(transfer), auth, deps);
  }, runtime);

  const reverseTransferRpc = secureRpc(parseReverseTransferCommand, (command, auth, deps) => {
    const transfer = reverseTransfer(command, writableDeps(auth, deps));
    return mutationResult(transfer.actionId, toTransferView(transfer), auth, deps);
  }, runtime);

  const createExpectedIncomeRpc = secureRpc(parseExpectedIncomeProposal, (proposal, auth, deps) => {
    const income = createExpectedIncome(proposal, writableDeps(auth, deps));
    return mutationResult(income.actionId, toIncomeView(income), auth, deps);
  }, runtime);

  // Combines the two lifecycle transitions (mark received / cancel) behind one endpoint: the
  // client's only choice at this point is which terminal status to move an expected income to,
  // so `status` selects the underlying income-service function directly rather than inventing a
  // parallel "action" vocabulary the client would have to translate back to a status anyway.
  const updateExpectedIncomeRpc = secureRpc(parseUpdateIncomeCommand, (command, auth, deps) => {
    const serviceDeps = writableDeps(auth, deps);
    const income = command.status === "RECEIVED"
      ? markIncomeReceived({ actionId: command.actionId }, serviceDeps)
      : cancelExpectedIncome({ actionId: command.actionId }, serviceDeps);
    return mutationResult(income.actionId, toIncomeView(income), auth, deps);
  }, runtime);

  const getHistoryRpc = secureRpc(parseEmptyCommand, (_input, auth): HistoryView => {
    const plans = new PlanRepository(auth).list().filter(plan => TERMINAL_PLAN_STATUSES.has(plan.status));
    const transfers = new TransferRepository(auth).list().filter(transfer => transfer.status === "REVERSED");
    const income = new IncomeRepository(auth).list().filter(entry => TERMINAL_INCOME_STATUSES.has(entry.status));
    return { plans: plans.map(toPlanView), transfers: transfers.map(toTransferView), income: income.map(toIncomeView) };
  }, runtime);

  // Bundles both read-only analyses (recurring transfer patterns and the baseline-rebalancing
  // suggestion derived from them) into one response: they share the same six-closed-month
  // transfer-ledger window, and the client's insights screen wants both at once rather than
  // issuing two round-trips for one conceptual view.
  const getInsightsRpc = secureRpc(parseEmptyCommand, (_input, auth, deps): InsightsView => {
    const insightDeps = { auth, clock: requestClock(deps) };
    const patterns = getTransferPatternInsights({}, insightDeps);
    const baselineReview = reviewBaselineChangeSuggestions({}, insightDeps);
    return { transferPatterns: toTransferPatternView(patterns), baselineReview: toBaselineReviewProposalView(baselineReview) };
  }, runtime);

  const applyBaselineReviewRpc = secureRpc(parseApprovedBaselineChange, (command, auth, deps) => {
    const result = applyApprovedBaselineChange(command, writableDeps(auth, deps));
    return mutationResult(result.actionId, toBaselineReviewResultView(result), auth, deps);
  }, runtime);

  return {
    getBootstrap,
    checkPurchaseRpc,
    reservePurchaseRpc,
    overridePurchaseRpc,
    cancelPlanRpc,
    completePlanRpc,
    createTransferRpc,
    reverseTransferRpc,
    createExpectedIncomeRpc,
    updateExpectedIncomeRpc,
    getHistoryRpc,
    getInsightsRpc,
    applyBaselineReviewRpc,
  };
}
