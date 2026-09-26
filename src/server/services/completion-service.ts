import { DomainError } from "../../domain/errors";
import { inputObject, isActivePlan, parseActionId, transitionPlan, type Plan } from "../../domain/plans";
import type { RequestClock } from "../../domain/time";
import type { PlanningSnapshot } from "../../domain/types";
import { evaluatePurchase } from "../../domain/recommendation";
import type { AuthContext } from "../auth";
import { findAppliedAction } from "../idempotency";
import { withDocumentLock, type DocumentLock } from "../lock";
import { appendExpenseWithKey, expenseTransactionExists } from "../workbook/sheets-api";
import { PlanRepository } from "../workbook/plan-repository";
import { readPlanningSnapshot } from "../workbook/snapshot-reader";
import type { WorkbookSourceMap } from "../workbook/source-map";

/** The secure RPC boundary supplies the authorized workbook and one captured request clock. */
export interface CompletionServiceDeps {
  auth: AuthContext;
  clock: RequestClock;
  sourceMap: WorkbookSourceMap;
  lock: DocumentLock | null;
  flush?: () => void;
}

/**
 * Converts one RESERVED or OVERRIDDEN plan into exactly one Catat - Pengeluaran row. The plan's
 * own action ID doubles as the deterministic transaction key: a developer-metadata search for
 * that key is the durable, externally verifiable record of whether the actual row was already
 * written, so a retry after a lost acknowledgment reconciles instead of appending a duplicate.
 */
export function completePlan(command: unknown, deps: CompletionServiceDeps): Plan {
  const actionId = parseActionId(inputObject(command).actionId);
  return withDocumentLock(deps.lock, () => {
    const repository = new PlanRepository(deps.auth);
    const current = findAppliedAction(repository.list(), actionId);
    if (!current) throw new DomainError("INVALID_INPUT");
    const snapshot = currentSnapshot(deps);
    const transactionKey = current.actionId;
    const expenseExists = expenseTransactionExists(deps.auth, transactionKey);
    if (current.status === "COMPLETED") return current;
    if (expenseExists && (isActivePlan(current) || current.status === "EXPIRED")) {
      const completed: Plan = { ...current, status: "COMPLETED", completedAt: deps.clock.nowIso, actualTransactionKey: transactionKey };
      repository.reconcileCompleted(completed);
      flush(deps);
      return completed;
    }
    if (!isActivePlan(current)) throw new DomainError("INVALID_INPUT");
    if (current.month < deps.clock.month) {
      repository.update({ ...current, status: transitionPlan(current.status, "EXPIRED") });
      flush(deps);
      throw new DomainError("INVALID_INPUT");
    }
    assertKnownIdentities(snapshot, current);
    if (current.status === "RESERVED") {
      const withoutOwnReservation = removeReservation(snapshot, current);
      const decision = evaluatePurchase(withoutOwnReservation, current);
      if (decision.verdict !== "RECOMMENDED") {
        throw new DomainError(!decision.category.passed ? "CATEGORY_BUDGET_EXCEEDED" : !decision.account.passed ? "ACCOUNT_LIQUIDITY_EXCEEDED" : "PROTECTED_SAVINGS_EXCEEDED");
      }
    }
    if (!expenseExists) {
      appendExpenseWithKey(deps.auth, deps.sourceMap, {
        date: current.plannedDate, category: current.category, detail: current.item,
        account: current.paymentAccount, amount: current.amount,
      }, transactionKey);
    }

    const completed: Plan = { ...current, status: transitionPlan(current.status, "COMPLETED"), completedAt: deps.clock.nowIso, actualTransactionKey: transactionKey };
    repository.update(completed);
    flush(deps);
    return completed;
  });
}

function removeReservation(snapshot: PlanningSnapshot, plan: Plan): PlanningSnapshot {
  const category = snapshot.categories[plan.category];
  return {
    ...snapshot,
    categories: {
      ...snapshot.categories,
      [plan.category]: {
        ...category,
        activeReservations: (category.activeReservations - plan.amount) as never,
        availableBudget: category.availableBudget + plan.amount,
      },
    },
    activeReservations: snapshot.activeReservations.filter(reservation => reservation.actionId !== plan.actionId),
  };
}

function currentSnapshot(deps: CompletionServiceDeps): PlanningSnapshot {
  const snapshot = readPlanningSnapshot(deps.auth, deps.clock, deps.sourceMap);
  if (snapshot.health !== "HEALTHY") throw new DomainError("WORKBOOK_SCHEMA_INVALID");
  return snapshot;
}

function assertKnownIdentities(snapshot: PlanningSnapshot, plan: Plan): void {
  if (!Object.hasOwnProperty.call(snapshot.categories, plan.category) || !Object.hasOwnProperty.call(snapshot.accounts, plan.paymentAccount)) throw new DomainError("INVALID_INPUT");
}

function flush(deps: CompletionServiceDeps): void { (deps.flush ?? (() => SpreadsheetApp.flush()))(); }
