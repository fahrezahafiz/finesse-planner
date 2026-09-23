import { DomainError } from "../../domain/errors";
import { inputObject, isActivePlan, parseActionId, transitionPlan, type Plan } from "../../domain/plans";
import type { RequestClock } from "../../domain/time";
import type { PlanningSnapshot } from "../../domain/types";
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
    if (current.status === "COMPLETED") return current;
    if (!isActivePlan(current)) throw new DomainError("INVALID_INPUT");

    const snapshot = currentSnapshot(deps);
    assertKnownIdentities(snapshot, current);

    const transactionKey = current.actionId;
    if (!expenseTransactionExists(deps.auth, transactionKey)) {
      appendExpenseWithKey(deps.auth, deps.sourceMap, {
        date: deps.clock.today, category: current.category, detail: current.item,
        account: current.paymentAccount, amount: current.amount,
      }, transactionKey);
    }

    const completed: Plan = { ...current, status: transitionPlan(current.status, "COMPLETED"), completedAt: deps.clock.nowIso, actualTransactionKey: transactionKey };
    repository.update(completed);
    flush(deps);
    return completed;
  });
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
