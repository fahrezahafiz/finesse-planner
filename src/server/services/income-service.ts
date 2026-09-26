import { DomainError } from "../../domain/errors";
import { newExpectedIncome, parseExpectedIncomeProposal, transitionIncome, type ExpectedIncome, type IncomeStatus } from "../../domain/expected-income";
import { inputObject, parseActionId } from "../../domain/plans";
import type { RequestClock } from "../../domain/time";
import type { PlanningSnapshot } from "../../domain/types";
import type { AuthContext } from "../auth";
import { findAppliedAction } from "../idempotency";
import { withDocumentLock, type DocumentLock } from "../lock";
import { IncomeRepository } from "../workbook/income-repository";
import { readPlanningSnapshot } from "../workbook/snapshot-reader";
import type { WorkbookSourceMap } from "../workbook/source-map";

/** The secure RPC boundary supplies the authorized workbook and one captured request clock. */
export interface IncomeServiceDeps {
  auth: AuthContext;
  clock: RequestClock;
  sourceMap: WorkbookSourceMap;
  lock: DocumentLock | null;
  flush?: () => void;
}

export function createExpectedIncome(command: unknown, deps: IncomeServiceDeps): ExpectedIncome {
  const proposal = parseExpectedIncomeProposal(command);
  return withDocumentLock(deps.lock, () => {
    const repository = new IncomeRepository(deps.auth);
    const snapshot = incomeMaintenanceSnapshot(deps);
    const previous = findAppliedAction(repository.list(), proposal.actionId);
    if (previous) return previous;
    if (!Object.hasOwnProperty.call(snapshot.accounts, proposal.destinationAccount)) throw new DomainError("INVALID_INPUT");
    const income = newExpectedIncome(proposal, deps.clock, deps.auth.email);
    repository.append(income);
    flush(deps);
    return income;
  });
}

export function markIncomeReceived(command: unknown, deps: IncomeServiceDeps): ExpectedIncome {
  return transitionIncomeStatus(command, deps, "RECEIVED");
}

export function cancelExpectedIncome(command: unknown, deps: IncomeServiceDeps): ExpectedIncome {
  return transitionIncomeStatus(command, deps, "CANCELLED");
}

function transitionIncomeStatus(command: unknown, deps: IncomeServiceDeps, next: IncomeStatus): ExpectedIncome {
  const actionId = parseActionId(inputObject(command).actionId);
  return withDocumentLock(deps.lock, () => {
    incomeMaintenanceSnapshot(deps);
    const repository = new IncomeRepository(deps.auth);
    const current = repository.list().find(entry => entry.actionId === actionId);
    if (!current) throw new DomainError("INVALID_INPUT");
    if (current.status === next) return current;
    const updated = { ...current, status: transitionIncome(current.status, next) };
    repository.update(updated);
    flush(deps);
    return updated;
  });
}

function incomeMaintenanceSnapshot(deps: IncomeServiceDeps): PlanningSnapshot {
  const snapshot = readPlanningSnapshot(deps.auth, deps.clock, deps.sourceMap);
  if (snapshot.health !== "HEALTHY" && snapshot.health !== "UNDERFUNDED") throw new DomainError("WORKBOOK_SCHEMA_INVALID");
  return snapshot;
}

function flush(deps: IncomeServiceDeps): void { (deps.flush ?? (() => SpreadsheetApp.flush()))(); }
