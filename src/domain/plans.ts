import { DomainError } from "./errors";
import type { RequestClock } from "./time";
import type { Decision, PlanStatus, Proposal, Verdict, YearMonth } from "./types";
import { parseLocalDate, parseMoney } from "./validation";

export interface Plan extends Proposal {
  createdAt: string;
  createdBy: string;
  month: YearMonth;
  status: PlanStatus;
  verdict: Verdict;
  failedGuardrails: readonly string[];
  categoryBefore: number;
  categoryAfter: number;
  savingsBefore: number;
  savingsAfter: number;
  accountBefore: number;
  accountAfter: number;
  overrideReason: string;
  completedAt: string | null;
  actualTransactionKey: string;
}

export const allowedTransitions: Record<PlanStatus, PlanStatus[]> = {
  RESERVED: ["COMPLETED", "CANCELLED", "EXPIRED"],
  OVERRIDDEN: ["COMPLETED", "CANCELLED", "EXPIRED"],
  COMPLETED: [],
  CANCELLED: [],
  EXPIRED: [],
};

export function transitionPlan(current: PlanStatus, next: PlanStatus): PlanStatus {
  if (!Object.hasOwnProperty.call(allowedTransitions, current) || !allowedTransitions[current].includes(next)) throw new DomainError("INVALID_INPUT");
  return next;
}

export function isActivePlan(plan: Pick<Plan, "status">): boolean {
  return plan.status === "RESERVED" || plan.status === "OVERRIDDEN";
}

export function parseActionId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) throw new DomainError("INVALID_INPUT");
  return value;
}

export function parseText(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw new DomainError("INVALID_INPUT");
  return value;
}

export function inputObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DomainError("INVALID_INPUT");
  return value as Record<string, unknown>;
}

export function parseProposal(value: unknown, clock?: RequestClock): Proposal {
  const input = inputObject(value);
  const actionId = parseActionId(input.actionId);
  const amount = parseMoney(input.amount);
  if (!amount) throw new DomainError("INVALID_AMOUNT");
  const plannedDate = parseLocalDate(input.plannedDate);
  if (clock && (plannedDate < clock.today || plannedDate > clock.monthEnd || plannedDate.slice(0, 7) !== clock.month)) throw new DomainError("INVALID_DATE");
  return { actionId, amount, plannedDate, item: parseText(input.item), category: parseText(input.category), paymentAccount: parseText(input.paymentAccount) };
}

export function parseOverrideReason(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new DomainError("OVERRIDE_REASON_REQUIRED");
  return parseText(value).trim();
}

export function exactPlanNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < -BigInt(Number.MAX_SAFE_INTEGER)) throw new DomainError("WORKBOOK_SCHEMA_INVALID");
  return Number(value);
}

/** Visible ledger snapshots retain the decision that originally created the plan. */
export function newPlan(proposal: Proposal, clock: RequestClock, email: string, decision: Decision,
  before: { category: number; savings: number; account: number }, reason?: string): Plan {
  const subtract = (left: number, right: number) => exactPlanNumber(BigInt(left) - BigInt(right));
  const overage = Math.max(0, subtract(proposal.amount, before.category));
  return {
    ...proposal, createdAt: clock.nowIso, createdBy: parseText(email), month: clock.month,
    status: reason === undefined ? "RESERVED" : "OVERRIDDEN", verdict: decision.verdict,
    failedGuardrails: [...decision.failedGuardrails],
    categoryBefore: before.category, categoryAfter: subtract(before.category, proposal.amount),
    savingsBefore: before.savings, savingsAfter: subtract(before.savings, overage),
    accountBefore: before.account, accountAfter: subtract(before.account, proposal.amount),
    overrideReason: reason ?? "", completedAt: null, actualTransactionKey: "",
  };
}
