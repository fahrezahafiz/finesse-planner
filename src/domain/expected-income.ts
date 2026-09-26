import { DomainError } from "./errors";
import { inputObject, parseActionId, parseText } from "./plans";
import type { RequestClock } from "./time";
import type { LocalDate, Money } from "./types";
import { parseLocalDate, parseMoney } from "./validation";

export type IncomeStatus = "CONFIRMED" | "RECEIVED" | "CANCELLED";

export interface ExpectedIncomeProposal {
  actionId: string;
  expectedDate: LocalDate;
  source: string;
  destinationAccount: string;
  amount: Money;
  note: string;
}

export interface ExpectedIncome extends ExpectedIncomeProposal {
  createdAt: string;
  createdBy: string;
  status: IncomeStatus;
}

export const allowedIncomeTransitions: Record<IncomeStatus, IncomeStatus[]> = {
  CONFIRMED: ["RECEIVED", "CANCELLED"],
  RECEIVED: [],
  CANCELLED: [],
};

export function transitionIncome(current: IncomeStatus, next: IncomeStatus): IncomeStatus {
  if (!Object.hasOwnProperty.call(allowedIncomeTransitions, current) || !allowedIncomeTransitions[current].includes(next)) throw new DomainError("INVALID_INPUT");
  return next;
}

export function parseExpectedIncomeProposal(value: unknown): ExpectedIncomeProposal {
  const input = inputObject(value);
  const actionId = parseActionId(input.actionId);
  const amount = parseMoney(input.amount);
  if (!amount) throw new DomainError("INVALID_AMOUNT");
  const expectedDate = parseLocalDate(input.expectedDate);
  const source = parseText(input.source);
  const destinationAccount = parseText(input.destinationAccount);
  const note = input.note === undefined || input.note === "" ? "" : parseText(input.note);
  return { actionId, expectedDate, source, destinationAccount, amount, note };
}

export function newExpectedIncome(proposal: ExpectedIncomeProposal, clock: RequestClock, email: string): ExpectedIncome {
  return { ...proposal, createdAt: clock.nowIso, createdBy: parseText(email), status: "CONFIRMED" };
}

/**
 * Only CONFIRMED entries dated from today through the end of the planning month count toward the
 * forecast. RECEIVED and CANCELLED remain in history but never contribute, and an overdue CONFIRMED
 * entry stops contributing rather than counting indefinitely.
 */
export function countsInForecast(entry: Pick<ExpectedIncome, "status" | "expectedDate">, clock: Pick<RequestClock, "today" | "monthEnd">): boolean {
  return entry.status === "CONFIRMED" && entry.expectedDate >= clock.today && entry.expectedDate <= clock.monthEnd;
}

export function eligibleExpectedIncome(entries: readonly Pick<ExpectedIncome, "status" | "expectedDate" | "amount">[], clock: Pick<RequestClock, "today" | "monthEnd">): number {
  return entries.filter(entry => countsInForecast(entry, clock)).reduce((sum, entry) => sum + entry.amount, 0);
}
