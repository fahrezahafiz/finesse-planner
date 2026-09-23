import type { RpcResult } from "../server/rpc";
import type {
  BaselineReviewResultView,
  HistoryView,
  IncomeView,
  InsightsView,
  MutationResultView,
  PlanningStateView,
  PlanView,
  PurchaseCheckView,
  TransferView,
} from "../server/view-models";
import type { Proposal } from "../domain/types";
import type { TransferProposal } from "../domain/transfers";
import type { ExpectedIncomeProposal } from "../domain/expected-income";
import type { ApprovedBaselineChangeCommand } from "../domain/insights";

export type ApiError = { code: string; message: string; authorizationUrl?: string };

/**
 * Abstraction over "call a named server RPC function and get an RpcResult back", so api.ts's
 * typed methods never touch google.script.run directly. Production uses createGoogleScriptRunner();
 * tests inject a fake that resolves/rejects without a real Apps Script runtime.
 */
export interface ScriptRunner {
  run<T>(functionName: string, ...args: unknown[]): Promise<RpcResult<T>>;
}

/**
 * Minimal shape of the browser-injected google.script.run object this file needs.
 * @types/google-apps-script only types the server-side GoogleAppsScript.* namespace, not this
 * client-side global, so it's declared here rather than left as `any`.
 */
interface GoogleScriptRunHandle {
  withSuccessHandler(callback: (value: unknown) => void): GoogleScriptRunHandle;
  withFailureHandler(callback: (error: unknown) => void): GoogleScriptRunHandle;
}

interface GoogleScriptGlobal {
  script: { run: GoogleScriptRunHandle };
}

// Real in the deployed Apps Script webapp, absent in jsdom - guarded with `typeof` below so
// referencing it never throws when it doesn't exist.
declare const google: GoogleScriptGlobal | undefined;

/**
 * Wraps google.script.run's callback API (withSuccessHandler/withFailureHandler) in a Promise.
 * Rejects immediately (without touching `google`) when the Apps Script runtime isn't present, so
 * this is safe to construct in any environment - it only fails if actually called.
 */
export function createGoogleScriptRunner(): ScriptRunner {
  return {
    run<T>(functionName: string, ...args: unknown[]): Promise<RpcResult<T>> {
      return new Promise((resolve, reject) => {
        if (typeof google === "undefined") {
          reject(new Error(`google.script.run is unavailable; cannot call ${functionName}`));
          return;
        }
        const handle = google.script.run
          .withSuccessHandler((value: unknown) => resolve(value as RpcResult<T>))
          .withFailureHandler((error: unknown) => reject(error));
        (handle as unknown as Record<string, (...callArgs: unknown[]) => void>)[functionName](...args);
      });
    },
  };
}

async function unwrap<T>(runner: ScriptRunner, functionName: string, ...args: unknown[]): Promise<T> {
  const result = await runner.run<T>(functionName, ...args);
  if (result.ok) return result.data;
  throw result.error as ApiError;
}

/** One typed method per secured RPC endpoint from src/server/endpoints.ts. */
export interface ApiClient {
  getBootstrap(): Promise<PlanningStateView>;
  checkPurchase(proposal: Proposal): Promise<PurchaseCheckView>;
  reservePurchase(proposal: Proposal): Promise<MutationResultView<PlanView>>;
  overridePurchase(command: Proposal & { reason: string }): Promise<MutationResultView<PlanView>>;
  cancelPlan(command: { actionId: string }): Promise<MutationResultView<PlanView>>;
  completePlan(command: { actionId: string }): Promise<MutationResultView<PlanView>>;
  createTransfer(proposal: TransferProposal): Promise<MutationResultView<TransferView>>;
  reverseTransfer(command: { actionId: string; transferId: string }): Promise<MutationResultView<TransferView>>;
  createExpectedIncome(proposal: ExpectedIncomeProposal): Promise<MutationResultView<IncomeView>>;
  updateExpectedIncome(command: {
    actionId: string;
    status: "RECEIVED" | "CANCELLED";
  }): Promise<MutationResultView<IncomeView>>;
  getHistory(): Promise<HistoryView>;
  getInsights(): Promise<InsightsView>;
  applyBaselineReview(command: ApprovedBaselineChangeCommand): Promise<MutationResultView<BaselineReviewResultView>>;
}

/** Builds the typed API client. Defaults to the real Apps Script runner; tests pass a fake. */
export function createApi(runner: ScriptRunner = createGoogleScriptRunner()): ApiClient {
  return {
    getBootstrap: () => unwrap(runner, "getBootstrap"),
    checkPurchase: proposal => unwrap(runner, "checkPurchaseRpc", proposal),
    reservePurchase: proposal => unwrap(runner, "reservePurchaseRpc", proposal),
    overridePurchase: command => unwrap(runner, "overridePurchaseRpc", command),
    cancelPlan: command => unwrap(runner, "cancelPlanRpc", command),
    completePlan: command => unwrap(runner, "completePlanRpc", command),
    createTransfer: proposal => unwrap(runner, "createTransferRpc", proposal),
    reverseTransfer: command => unwrap(runner, "reverseTransferRpc", command),
    createExpectedIncome: proposal => unwrap(runner, "createExpectedIncomeRpc", proposal),
    updateExpectedIncome: command => unwrap(runner, "updateExpectedIncomeRpc", command),
    getHistory: () => unwrap(runner, "getHistoryRpc"),
    getInsights: () => unwrap(runner, "getInsightsRpc"),
    applyBaselineReview: command => unwrap(runner, "applyBaselineReviewRpc", command),
  };
}
