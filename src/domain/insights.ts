import { DomainError } from "./errors";
import { inputObject, parseActionId, parseText } from "./plans";
import { PROTECTED_SAVINGS_CATEGORY, type Transfer } from "./transfers";
import type { Money, YearMonth } from "./types";
import { parseMoney, parseYearMonth } from "./validation";

/** Recurring-pattern evidence is drawn from this many closed calendar months immediately before the current one. */
export const CLOSED_MONTH_WINDOW = 6;

/**
 * A category must show a nonzero net direction (recipient or donor) in at least this many of the
 * six closed months before it counts as a recurring pattern at all. One occurrence is a single
 * event, not a pattern; two or more is the minimum evidence for "recurring".
 */
const MINIMUM_RECURRING_FREQUENCY = 2;

export interface RecurringCategoryPattern {
  readonly category: string;
  /** How many of the six closed months showed a net movement in this direction for this category. */
  readonly frequency: number;
  /** Sum of the net monthly amounts across the contributing months. */
  readonly total: Money;
  /** total divided by frequency, rounded to the nearest whole IDR. */
  readonly averageMonthlyNet: Money;
}

export interface TransferPatternAnalysis {
  readonly windowMonths: readonly YearMonth[];
  readonly recurringRecipients: readonly RecurringCategoryPattern[];
  readonly recurringDonors: readonly RecurringCategoryPattern[];
}

/**
 * Pure analysis over full transfer history. Only ACTIVE-status rows carry a lasting effect: when a
 * transfer is reversed, its original row flips to REVERSED and the reversing entry is appended
 * already REVERSED (Task 8's design, see transfers.ts's reversingTransfer), specifically so that
 * neither independently affects aggregation. That is exactly the rule applied here for history, the
 * same rule the live snapshot reader already applies for the current month: a reversed transfer left
 * no lasting effect on the category, so it contributes nothing to recurrence evidence.
 */
export function analyzeTransferPatterns(transfers: readonly Transfer[], currentMonth: YearMonth): TransferPatternAnalysis {
  const windowMonths = closedMonthWindow(currentMonth);
  const windowSet = new Set<string>(windowMonths);
  const active = transfers.filter(transfer => transfer.status === "ACTIVE" && windowSet.has(transfer.month));

  const monthlyNet = new Map<string, Map<string, number>>();
  for (const month of windowMonths) monthlyNet.set(month, new Map());
  for (const transfer of active) {
    const net = monthlyNet.get(transfer.month)!;
    net.set(transfer.toCategory, (net.get(transfer.toCategory) ?? 0) + transfer.amount);
    net.set(transfer.fromCategory, (net.get(transfer.fromCategory) ?? 0) - transfer.amount);
  }

  const recipientTotals = new Map<string, { frequency: number; total: number }>();
  const donorTotals = new Map<string, { frequency: number; total: number }>();
  for (const net of monthlyNet.values()) {
    for (const [category, amount] of net) {
      if (category === PROTECTED_SAVINGS_CATEGORY) continue; // never a transfer category; defense in depth.
      if (amount > 0) accumulate(recipientTotals, category, amount);
      else if (amount < 0) accumulate(donorTotals, category, -amount);
    }
  }

  return {
    windowMonths,
    recurringRecipients: toPatterns(recipientTotals),
    recurringDonors: toPatterns(donorTotals),
  };
}

export type BaselineChangeDirection = "INCREASE" | "DECREASE";

export interface BaselineChangeSuggestion {
  readonly category: string;
  readonly direction: BaselineChangeDirection;
  readonly amount: Money;
  readonly frequency: number;
  readonly averageMonthlyNet: Money;
}

export interface BaselineReviewProposal {
  readonly windowMonths: readonly YearMonth[];
  readonly changes: readonly BaselineChangeSuggestion[];
}

/**
 * Suggestion only: never writes. Pairs evidence-backed recurring-recipient increases with
 * evidence-backed recurring-donor reductions. Each suggested amount is capped by that category's own
 * observed average monthly net, so a suggestion never invents evidence a donor or recipient does not
 * have. The total proposed is further capped to the smaller of total recipient evidence and total
 * donor evidence, so increases and decreases always sum to exactly zero. When there is no recurring
 * donor evidence at all, the cap is zero and no changes are proposed.
 */
export function proposeBaselineReview(transfers: readonly Transfer[], currentMonth: YearMonth): BaselineReviewProposal {
  const analysis = analyzeTransferPatterns(transfers, currentMonth);
  // A category that is a recurring recipient in some months and a recurring donor in others has no
  // consistent role: its evidence cannot honestly support a one-directional, permanent baseline
  // change in either direction, so it is excluded from both suggestion sides entirely.
  const donorCategories = new Set(analysis.recurringDonors.map(pattern => pattern.category));
  const recipientCategories = new Set(analysis.recurringRecipients.map(pattern => pattern.category));
  const recipients = analysis.recurringRecipients.filter(pattern => !donorCategories.has(pattern.category));
  const donors = analysis.recurringDonors.filter(pattern => !recipientCategories.has(pattern.category));

  const budget = Math.min(sumEvidence(recipients), sumEvidence(donors));

  const changes: BaselineChangeSuggestion[] = [
    ...allocate(recipients, budget, "INCREASE"),
    ...allocate(donors, budget, "DECREASE"),
  ];

  return { windowMonths: analysis.windowMonths, changes };
}

export interface ReviewedBaselineChange {
  readonly category: string;
  readonly expectedAmount: Money;
  readonly newAmount: Money;
}

export interface ApprovedBaselineChangeCommand {
  readonly actionId: string;
  readonly reason: string;
  readonly changes: readonly ReviewedBaselineChange[];
}

/**
 * Parses a human-reviewed baseline-change approval. This never touches the workbook: it only
 * validates the shape of the request and the zero-sum invariant of the reviewed numbers. The
 * caller identity and the exact-cell / freshness checks happen in baseline-review-service.ts, which
 * has access to the workbook.
 */
export function parseApprovedBaselineChange(value: unknown): ApprovedBaselineChangeCommand {
  const input = inputObject(value);
  const actionId = parseActionId(input.actionId);
  const reason = parseText(input.reason);
  if (!Array.isArray(input.changes) || input.changes.length < 2) throw new DomainError("INVALID_INPUT");

  const seen = new Set<string>();
  const changes = input.changes.map(raw => {
    const item = inputObject(raw);
    const category = parseText(item.category);
    if (category === PROTECTED_SAVINGS_CATEGORY) throw new DomainError("INVALID_INPUT");
    if (seen.has(category)) throw new DomainError("INVALID_INPUT");
    seen.add(category);
    const expectedAmount = parseMoney(item.expectedAmount);
    const newAmount = parseMoney(item.newAmount);
    return { category, expectedAmount, newAmount };
  });

  if (changes.every(change => change.newAmount === change.expectedAmount)) throw new DomainError("INVALID_INPUT");
  const net = changes.reduce((sum, change) => sum + (change.newAmount - change.expectedAmount), 0);
  if (net !== 0) throw new DomainError("INVALID_INPUT");

  return { actionId, reason, changes };
}

function sumEvidence(patterns: readonly RecurringCategoryPattern[]): number {
  return patterns.reduce((sum, pattern) => sum + pattern.averageMonthlyNet, 0);
}

/** Greedily fills up to `budget` in priority order, never allocating more than a category's own evidence. */
function allocate(patterns: readonly RecurringCategoryPattern[], budget: number, direction: BaselineChangeDirection): BaselineChangeSuggestion[] {
  const changes: BaselineChangeSuggestion[] = [];
  let remaining = budget;
  for (const pattern of patterns) {
    if (remaining <= 0) break;
    const amount = Math.min(pattern.averageMonthlyNet, remaining);
    if (amount <= 0) continue;
    changes.push({ category: pattern.category, direction, amount: parseMoney(amount), frequency: pattern.frequency, averageMonthlyNet: pattern.averageMonthlyNet });
    remaining -= amount;
  }
  return changes;
}

function accumulate(map: Map<string, { frequency: number; total: number }>, category: string, amount: number): void {
  const entry = map.get(category) ?? { frequency: 0, total: 0 };
  entry.frequency += 1;
  entry.total += amount;
  map.set(category, entry);
}

function toPatterns(map: Map<string, { frequency: number; total: number }>): RecurringCategoryPattern[] {
  return [...map.entries()]
    .filter(([, { frequency }]) => frequency >= MINIMUM_RECURRING_FREQUENCY)
    .map(([category, { frequency, total }]) => ({
      category,
      frequency,
      total: parseMoney(total),
      averageMonthlyNet: parseMoney(Math.round(total / frequency)),
    }))
    .sort((a, b) => b.frequency - a.frequency || b.total - a.total || a.category.localeCompare(b.category));
}

function closedMonthWindow(currentMonth: YearMonth): YearMonth[] {
  const match = /^(\d{4})-(\d{2})$/.exec(currentMonth);
  if (!match) throw new DomainError("INVALID_MONTH");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const months: YearMonth[] = [];
  for (let offset = CLOSED_MONTH_WINDOW; offset >= 1; offset--) {
    const index = year * 12 + (month - 1) - offset;
    const y = Math.floor(index / 12);
    const m = (index % 12) + 1;
    months.push(parseYearMonth(`${y}-${String(m).padStart(2, "0")}`));
  }
  return months;
}
