import { DomainError } from "../../domain/errors";
import { exactPlanNumber, inputObject, isActivePlan, newPlan, parseActionId, parseOverrideReason, parseProposal, transitionPlan, type Plan } from "../../domain/plans";
import { evaluatePurchase, plannedAccountLiquidity } from "../../domain/recommendation";
import type { RequestClock } from "../../domain/time";
import type { Decision, PlanningSnapshot, Proposal } from "../../domain/types";
import type { AuthContext } from "../auth";
import { findAppliedAction } from "../idempotency";
import { withDocumentLock, type DocumentLock } from "../lock";
import { PlanRepository } from "../workbook/plan-repository";
import { readPlanningSnapshot } from "../workbook/snapshot-reader";
import { expenseTransactionExists } from "../workbook/sheets-api";
import type { WorkbookSourceMap } from "../workbook/source-map";

/** The secure RPC boundary supplies the authorized workbook and one captured request clock. */
export interface PlanServiceDeps {
  auth: AuthContext;
  clock: RequestClock;
  sourceMap: WorkbookSourceMap;
  lock: DocumentLock | null;
  flush?: () => void;
}

export function checkPurchase(command: unknown, deps: PlanServiceDeps): Decision {
  const proposal = parseProposal(command, deps.clock);
  flush(deps);
  return evaluatePurchase(readPlanningSnapshot(deps.auth, deps.clock, deps.sourceMap), proposal);
}

export function reservePurchase(command: unknown, deps: PlanServiceDeps): Plan {
  return createPurchase(command, deps);
}

export function overridePurchase(command: unknown, deps: PlanServiceDeps): Plan {
  return createPurchase(command, deps, parseOverrideReason(inputObject(command).reason));
}

function createPurchase(command: unknown, deps: PlanServiceDeps, reason?: string): Plan {
  const proposal = parseProposal(command);
  return withDocumentLock(deps.lock, () => {
    const repository = new PlanRepository(deps.auth);
    flush(deps);
    currentSnapshot(deps);
    expire(repository, deps);
    const previous = findAppliedAction(repository.list(), proposal.actionId);
    if (previous) return previous;
    parseProposal(proposal, deps.clock);
    const snapshot = currentSnapshot(deps);
    assertKnownIdentities(snapshot, proposal);
    const decision = evaluatePurchase(snapshot, proposal);
    if (decision.verdict === "UNABLE_TO_EVALUATE") throw new DomainError("WORKBOOK_SCHEMA_INVALID");
    if (reason === undefined && decision.verdict !== "RECOMMENDED") {
      throw new DomainError(!decision.category.passed ? "CATEGORY_BUDGET_EXCEEDED" : "INVALID_INPUT");
    }
    const account = plannedAccountLiquidity(snapshot, proposal);
    if (account === null) throw new DomainError("WORKBOOK_SCHEMA_INVALID");
    const plan = newPlan(proposal, deps.clock, deps.auth.email, decision, {
      category: snapshot.categories[proposal.category].availableBudget,
      savings: exactPlanNumber(BigInt(snapshot.actualIncome) + BigInt(snapshot.confirmedFutureIncome) - BigInt(snapshot.totalAdjustedBudgets)),
      account,
    }, reason);
    repository.append(plan);
    flush(deps);
    return plan;
  });
}

export function cancelPlan(command: unknown, deps: PlanServiceDeps): Plan {
  const actionId = parseActionId(inputObject(command).actionId);
  return withDocumentLock(deps.lock, () => {
    const repository = new PlanRepository(deps.auth);
    currentSnapshot(deps);
    const previous = findAppliedAction(repository.list(), actionId);
    if (!previous) throw new DomainError("INVALID_INPUT");
    if (previous.status === "CANCELLED") return previous;
    expire(repository, deps);
    const current = findAppliedAction(repository.list(), actionId)!;
    if (!isActivePlan(current)) throw new DomainError("INVALID_INPUT");
    const snapshot = currentSnapshot(deps);
    // Cancellation releases money regardless of affordability, but still validates fresh inputs.
    assertKnownIdentities(snapshot, current);
    if (evaluatePurchase(snapshot, current).verdict === "UNABLE_TO_EVALUATE") throw new DomainError("WORKBOOK_SCHEMA_INVALID");
    const cancelled = { ...current, status: transitionPlan(current.status, "CANCELLED") };
    repository.update(cancelled);
    flush(deps);
    return cancelled;
  });
}

export function expirePastPlans(command: unknown, deps: PlanServiceDeps): Plan[] {
  parseActionId(inputObject(command).actionId);
  return withDocumentLock(deps.lock, () => {
    const repository = new PlanRepository(deps.auth);
    flush(deps);
    currentSnapshot(deps);
    expire(repository, deps);
    // Return durable history so repeated rollover requests have the same result.
    return repository.list().filter(plan => plan.status === "EXPIRED" && plan.month < deps.clock.month);
  });
}

function expire(repository: PlanRepository, deps: PlanServiceDeps): void {
  for (const plan of repository.list()) {
    if (!isActivePlan(plan) || plan.month >= deps.clock.month) continue;
    if (expenseTransactionExists(deps.auth, plan.actionId)) {
      repository.update({ ...plan, status: transitionPlan(plan.status, "COMPLETED"), completedAt: deps.clock.nowIso, actualTransactionKey: plan.actionId });
    } else {
      repository.update({ ...plan, status: transitionPlan(plan.status, "EXPIRED") });
    }
  }
  flush(deps);
}

function currentSnapshot(deps: PlanServiceDeps): PlanningSnapshot {
  const snapshot = readPlanningSnapshot(deps.auth, deps.clock, deps.sourceMap);
  if (snapshot.health !== "HEALTHY") throw new DomainError("WORKBOOK_SCHEMA_INVALID");
  return snapshot;
}

function assertKnownIdentities(snapshot: PlanningSnapshot, proposal: Proposal): void {
  if (!Object.hasOwnProperty.call(snapshot.categories, proposal.category) || !Object.hasOwnProperty.call(snapshot.accounts, proposal.paymentAccount)) throw new DomainError("INVALID_INPUT");
}

function flush(deps: PlanServiceDeps): void { (deps.flush ?? (() => SpreadsheetApp.flush()))(); }
