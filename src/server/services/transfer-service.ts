import { DomainError } from "../../domain/errors";
import { inputObject, parseActionId } from "../../domain/plans";
import {
  assertReversibleMonth, newTransfer, parseTransferProposal, reversingTransfer,
  validateReversal, validateTransfer, type Transfer,
} from "../../domain/transfers";
import type { RequestClock } from "../../domain/time";
import type { PlanningSnapshot } from "../../domain/types";
import type { AuthContext } from "../auth";
import { findAppliedAction } from "../idempotency";
import { withDocumentLock, type DocumentLock } from "../lock";
import { TransferRepository } from "../workbook/transfer-repository";
import { readPlanningSnapshot } from "../workbook/snapshot-reader";
import type { WorkbookSourceMap } from "../workbook/source-map";

/** The secure RPC boundary supplies the authorized workbook and one captured request clock. */
export interface TransferServiceDeps {
  auth: AuthContext;
  clock: RequestClock;
  sourceMap: WorkbookSourceMap;
  lock: DocumentLock | null;
  flush?: () => void;
}

export function createTransfer(command: unknown, deps: TransferServiceDeps): Transfer {
  const proposal = parseTransferProposal(command);
  return withDocumentLock(deps.lock, () => {
    const repository = new TransferRepository(deps.auth);
    const snapshot = currentSnapshot(deps);
    const previous = findAppliedAction(repository.list(), proposal.actionId);
    if (previous) return previous;
    validateTransfer(snapshot, proposal);
    const transfer = newTransfer(proposal, deps.clock, deps.auth.email);
    repository.append(transfer);
    flush(deps);
    return transfer;
  });
}

export function reverseTransfer(command: unknown, deps: TransferServiceDeps): Transfer {
  const input = inputObject(command);
  const actionId = parseActionId(input.actionId);
  const transferId = parseActionId(input.transferId);
  return withDocumentLock(deps.lock, () => {
    const repository = new TransferRepository(deps.auth);
    const entries = repository.list();
    const original = entries.find(transfer => transfer.actionId === transferId);
    if (!original) throw new DomainError("INVALID_INPUT");
    const existingReversal = findAppliedAction(entries, actionId);
    if (existingReversal) {
      if (existingReversal.reversalReference !== original.actionId
        || existingReversal.fromCategory !== original.toCategory
        || existingReversal.toCategory !== original.fromCategory
        || existingReversal.amount !== original.amount) throw new DomainError("INVALID_INPUT");
      if (original.status === "ACTIVE") {
        assertReversibleMonth(original.month, deps.clock.month);
        const snapshot = currentSnapshot(deps);
        const recipient = snapshot.categories[original.toCategory];
        if (!recipient) throw new DomainError("INVALID_INPUT");
        validateReversal(recipient.availableBudget, original.amount);
        repository.commitReversal(original, existingReversal);
      }
      flush(deps);
      return existingReversal;
    }
    if (original.status !== "ACTIVE") throw new DomainError("INVALID_INPUT");
    assertReversibleMonth(original.month, deps.clock.month);
    const snapshot = currentSnapshot(deps);
    const recipient = snapshot.categories[original.toCategory];
    if (!recipient) throw new DomainError("INVALID_INPUT");
    validateReversal(recipient.availableBudget, original.amount);
    const reversal = reversingTransfer(original, actionId, deps.clock, deps.auth.email);
    repository.commitReversal(original, reversal);
    flush(deps);
    return reversal;
  });
}

function currentSnapshot(deps: TransferServiceDeps): PlanningSnapshot {
  const snapshot = readPlanningSnapshot(deps.auth, deps.clock, deps.sourceMap);
  if (snapshot.health !== "HEALTHY" && snapshot.health !== "UNDERFUNDED") throw new DomainError("WORKBOOK_SCHEMA_INVALID");
  return snapshot;
}

function flush(deps: TransferServiceDeps): void { (deps.flush ?? (() => SpreadsheetApp.flush()))(); }
