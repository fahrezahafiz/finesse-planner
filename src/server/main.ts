export { secureRpc } from "./rpc";
import { createEndpoints } from "./endpoints";

export function doGet(): GoogleAppsScript.HTML.HtmlOutput {
  return HtmlService.createTemplateFromFile("Index")
    .evaluate()
    .setTitle("Mindful Expense Planner")
    .addMetaTag("viewport", "width=device-width, initial-scale=1");
}

export function include(filename: string): string {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

export const {
  getBootstrap,
  checkPurchaseRpc,
  reservePurchaseRpc,
  overridePurchaseRpc,
  cancelPlanRpc,
  completePlanRpc,
  createTransferRpc,
  reverseTransferRpc,
  createExpectedIncomeRpc,
  updateExpectedIncomeRpc,
  getHistoryRpc,
  getInsightsRpc,
  applyBaselineReviewRpc,
} = createEndpoints();

Object.assign(globalThis, {
  doGet,
  include,
  getBootstrap,
  checkPurchaseRpc,
  reservePurchaseRpc,
  overridePurchaseRpc,
  cancelPlanRpc,
  completePlanRpc,
  createTransferRpc,
  reverseTransferRpc,
  createExpectedIncomeRpc,
  updateExpectedIncomeRpc,
  getHistoryRpc,
  getInsightsRpc,
  applyBaselineReviewRpc,
});
