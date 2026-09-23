import { DomainError } from "../../domain/errors";
import { allowedTransitions, parseActionId, parseText, type Plan } from "../../domain/plans";
import { jakartaClock } from "../../domain/time";
import { parseMoney, parseYearMonth } from "../../domain/validation";
import type { PlanStatus, Verdict } from "../../domain/types";
import type { AuthContext } from "../auth";
import { LAST_PLANNING_ROW, PLAN_HEADERS } from "./headers";
import { assertPlanningHeaders } from "./setup";

const guardrails = new Set(["PLANNING_MONTH_HEALTH", "CATEGORY_AVAILABILITY", "PROTECTED_SAVINGS", "ACCOUNT_LIQUIDITY", "SCHEMA_AND_FORMULA_HEALTH"]);

/** All reads and writes use the workbook already opened under the caller's authority. */
export class PlanRepository {
  constructor(private readonly auth: AuthContext) {}

  list(): Plan[] { return this.entries().map(entry => entry.plan); }

  append(plan: Plan): void {
    const entries = this.entries();
    if (entries.some(entry => entry.plan.actionId === plan.actionId)) invalid();
    const lastRow = Math.max(1, ...entries.map(entry => entry.row));
    if (lastRow >= LAST_PLANNING_ROW) invalid();
    this.write(lastRow + 1, plan);
  }

  update(plan: Plan): void {
    const entry = this.entries().find(entry => entry.plan.actionId === plan.actionId);
    if (!entry) invalid();
    if (entry.plan.status !== plan.status && !allowedTransitions[entry.plan.status].includes(plan.status)) invalid();
    // Lifecycle updates cannot rewrite the original proposal or guardrail evidence.
    const immutable = (value: Plan) => encodePlan(value).slice(0, 19).filter((_, index) => index !== 9);
    if (JSON.stringify(immutable(entry.plan)) !== JSON.stringify(immutable(plan))) invalid();
    this.write(entry.row, plan);
  }

  private sheet() {
    assertPlanningHeaders(this.auth.workbook);
    const sheet = this.auth.workbook.getSheetByName("Rencana Pengeluaran");
    if (!sheet || sheet.getMaxRows() < LAST_PLANNING_ROW || this.auth.workbook.getSpreadsheetTimeZone() !== "Asia/Jakarta") invalid();
    return sheet;
  }

  private entries(): { row: number; plan: Plan }[] {
    try {
      const range = this.sheet().getRange(`A2:U${LAST_PLANNING_ROW}`);
      const values = range.getValues();
      if (range.getFormulas().some(row => row.some(value => value !== ""))) invalid();
      const entries: { row: number; plan: Plan }[] = [];
      const ids = new Set<string>();
      values.forEach((row, index) => {
        if (row.every(value => value === "")) return;
        const plan = decodePlan(row);
        if (ids.has(plan.actionId)) invalid();
        ids.add(plan.actionId); entries.push({ row: index + 2, plan });
      });
      return entries;
    } catch { return invalid(); }
  }

  private write(row: number, plan: Plan): void {
    const values = encodePlan(plan);
    decodePlan(values); // Reject invalid repository values before any write.
    this.sheet().getRange(row, 1, 1, PLAN_HEADERS.length).setValues([values.map(value =>
      typeof value === "string" && value.startsWith("=") ? `'${value}` : value,
    )]);
  }
}

function encodePlan(plan: Plan): unknown[] {
  return [plan.actionId, new Date(plan.createdAt), plan.createdBy, plan.month, new Date(`${plan.plannedDate}T00:00:00+07:00`),
    plan.item, plan.category, plan.paymentAccount, plan.amount, plan.status, plan.verdict, JSON.stringify(plan.failedGuardrails),
    plan.categoryBefore, plan.categoryAfter, plan.savingsBefore, plan.savingsAfter, plan.accountBefore, plan.accountAfter,
    plan.overrideReason, plan.completedAt === null ? "" : new Date(plan.completedAt), plan.actualTransactionKey];
}

function decodePlan(row: unknown[]): Plan {
  try {
    if (row.length !== PLAN_HEADERS.length) invalid();
    const actionId = parseActionId(row[0]); const createdAt = sheetClock(row[1]).nowIso;
    const createdBy = parseText(row[2]); const month = parseYearMonth(row[3]);
    const plannedDate = sheetClock(row[4]).today;
    if (plannedDate.slice(0, 7) !== month) invalid();
    const item = parseText(row[5]), category = parseText(row[6]), paymentAccount = parseText(row[7]);
    const amount = parseMoney(row[8]); if (!amount) invalid();
    if (typeof row[9] !== "string" || !Object.hasOwnProperty.call(allowedTransitions, row[9])) invalid();
    const status = row[9] as PlanStatus;
    if (!["RECOMMENDED", "NOT_RECOMMENDED", "UNABLE_TO_EVALUATE"].includes(row[10] as string)) invalid();
    const verdict = row[10] as Verdict;
    if (typeof row[11] !== "string") invalid();
    const failedGuardrails: unknown = JSON.parse(row[11]);
    if (!Array.isArray(failedGuardrails) || failedGuardrails.some(value => typeof value !== "string" || !guardrails.has(value))
      || new Set(failedGuardrails).size !== failedGuardrails.length) invalid();
    if ((verdict === "RECOMMENDED") !== (failedGuardrails.length === 0)) invalid();
    const [categoryBefore, categoryAfter, savingsBefore, savingsAfter, accountBefore, accountAfter] = row.slice(12, 18).map(integer);
    const overage = BigInt(amount) > BigInt(categoryBefore) ? BigInt(amount) - BigInt(categoryBefore) : 0n;
    if (BigInt(categoryBefore) - BigInt(amount) !== BigInt(categoryAfter)
      || BigInt(accountBefore) - BigInt(amount) !== BigInt(accountAfter)
      || BigInt(savingsBefore) - overage !== BigInt(savingsAfter)) invalid();
    if (typeof row[18] !== "string" || row[18].length > 2000) invalid();
    const overrideReason = row[18];
    if (status === "OVERRIDDEN" && !overrideReason.trim()) invalid();
    if (status === "RESERVED" && (verdict !== "RECOMMENDED" || overrideReason !== "")) invalid();
    const completedAt = row[19] === "" ? null : sheetClock(row[19]).nowIso;
    const actualTransactionKey = row[20] === "" ? "" : parseActionId(row[20]);
    if (status === "COMPLETED" ? !completedAt || !actualTransactionKey : completedAt !== null) invalid();
    return { actionId, createdAt, createdBy, month, plannedDate, item, category, paymentAccount, amount, status, verdict,
      failedGuardrails, categoryBefore, categoryAfter, savingsBefore, savingsAfter, accountBefore, accountAfter, overrideReason, completedAt, actualTransactionKey };
  } catch { return invalid(); }
}

function sheetClock(value: unknown) { if (!(value instanceof Date)) invalid(); return jakartaClock(value); }
function integer(value: unknown): number { if (typeof value !== "number" || !Number.isSafeInteger(value)) invalid(); return value; }
function invalid(): never { throw new DomainError("WORKBOOK_SCHEMA_INVALID"); }
