import { analyzeTransferPatterns, proposeBaselineReview, type BaselineReviewProposal, type TransferPatternAnalysis } from "../../domain/insights";
import { inputObject } from "../../domain/plans";
import type { RequestClock } from "../../domain/time";
import type { AuthContext } from "../auth";
import { TransferRepository } from "../workbook/transfer-repository";

/** Read-only: no lock is taken and nothing is ever written. Both entry points recompute from the full transfer ledger every call. */
export interface InsightServiceDeps {
  auth: AuthContext;
  clock: RequestClock;
}

/** Recurring transfer-pattern evidence over the six closed months before the current one. */
export function getTransferPatternInsights(command: unknown, deps: InsightServiceDeps): TransferPatternAnalysis {
  inputObject(command);
  const transfers = new TransferRepository(deps.auth).list();
  return analyzeTransferPatterns(transfers, deps.clock.month);
}

/** A reviewable, evidence-backed baseline-rebalancing suggestion. Never writes; see baseline-review-service for the approval path. */
export function reviewBaselineChangeSuggestions(command: unknown, deps: InsightServiceDeps): BaselineReviewProposal {
  inputObject(command);
  const transfers = new TransferRepository(deps.auth).list();
  return proposeBaselineReview(transfers, deps.clock.month);
}
