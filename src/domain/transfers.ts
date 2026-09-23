import { DomainError } from "./errors";
import { inputObject, parseActionId, parseText } from "./plans";
import type { RequestClock } from "./time";
import type { Money, YearMonth } from "./types";
import { parseMoney } from "./validation";

export type TransferStatus = "ACTIVE" | "REVERSED";

/** The protected-savings envelope is a household scalar, never a transfer category. */
export const PROTECTED_SAVINGS_CATEGORY = "Savings";

export interface TransferProposal {
  actionId: string;
  fromCategory: string;
  toCategory: string;
  amount: Money;
  reason: string;
  relatedPlanId: string;
}

export interface Transfer extends TransferProposal {
  createdAt: string;
  createdBy: string;
  month: YearMonth;
  status: TransferStatus;
  reversalReference: string;
}

export const allowedTransferTransitions: Record<TransferStatus, TransferStatus[]> = {
  ACTIVE: ["REVERSED"],
  REVERSED: [],
};

export function transitionTransfer(current: TransferStatus, next: TransferStatus): TransferStatus {
  if (!Object.hasOwnProperty.call(allowedTransferTransitions, current) || !allowedTransferTransitions[current].includes(next)) throw new DomainError("INVALID_INPUT");
  return next;
}

export function parseTransferProposal(value: unknown): TransferProposal {
  const input = inputObject(value);
  const actionId = parseActionId(input.actionId);
  const amount = parseMoney(input.amount);
  if (!amount) throw new DomainError("INVALID_AMOUNT");
  const fromCategory = parseText(input.fromCategory);
  const toCategory = parseText(input.toCategory);
  if (fromCategory === toCategory) throw new DomainError("INVALID_INPUT");
  if (fromCategory === PROTECTED_SAVINGS_CATEGORY || toCategory === PROTECTED_SAVINGS_CATEGORY) throw new DomainError("INVALID_INPUT");
  const reason = parseText(input.reason);
  const relatedPlanId = input.relatedPlanId === undefined || input.relatedPlanId === "" ? "" : parseActionId(input.relatedPlanId);
  return { actionId, fromCategory, toCategory, amount, reason, relatedPlanId };
}

export interface TransferCategorySnapshot {
  readonly availableBudget: number;
}

export interface TransferSnapshot {
  readonly categories: Readonly<Record<string, TransferCategorySnapshot>>;
}

/** Both categories must exist in the fresh snapshot, and donor availability after actuals and reservations must remain nonnegative. */
export function validateTransfer(snapshot: TransferSnapshot, proposal: Pick<TransferProposal, "fromCategory" | "toCategory" | "amount">): void {
  const donor = snapshot.categories[proposal.fromCategory];
  const recipient = snapshot.categories[proposal.toCategory];
  if (!donor || !recipient) throw new DomainError("INVALID_INPUT");
  if (exact(donor.availableBudget) - exact(proposal.amount) < 0n) throw new DomainError("DONOR_BUDGET_EXCEEDED");
}

/** A reversal returns the amount from the original recipient back to the original donor; it must not leave the recipient negative. */
export function validateReversal(recipientAvailableBudget: number, amount: Money): void {
  if (exact(recipientAvailableBudget) - exact(amount) < 0n) throw new DomainError("RECIPIENT_BUDGET_EXCEEDED");
}

/** Transfers affect one calendar month only; a closed month can no longer be reversed. */
export function assertReversibleMonth(transferMonth: YearMonth, clockMonth: YearMonth): void {
  if (transferMonth !== clockMonth) throw new DomainError("INVALID_INPUT");
}

export function newTransfer(proposal: TransferProposal, clock: RequestClock, email: string): Transfer {
  return { ...proposal, createdAt: clock.nowIso, createdBy: parseText(email), month: clock.month, status: "ACTIVE", reversalReference: "" };
}

/**
 * The reversing entry is appended as its own auditable row, already REVERSED, so it never
 * independently affects category aggregation; only the original's status change (ACTIVE -> REVERSED)
 * removes its effect from the current month's summary.
 */
export function reversingTransfer(original: Transfer, actionId: string, clock: RequestClock, email: string): Transfer {
  return {
    actionId,
    fromCategory: original.toCategory,
    toCategory: original.fromCategory,
    amount: original.amount,
    reason: `Reversal of ${original.actionId}`,
    relatedPlanId: original.relatedPlanId,
    createdAt: clock.nowIso,
    createdBy: parseText(email),
    month: original.month,
    status: "REVERSED",
    reversalReference: original.actionId,
  };
}

function exact(value: number): bigint { return BigInt(value); }
