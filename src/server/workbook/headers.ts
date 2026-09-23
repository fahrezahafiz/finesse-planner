export const PLAN_HEADERS = [
  "Plan ID", "Created at", "Created by", "Budget month", "Planned date", "Item", "Category", "Payment account", "Amount", "Status", "Verdict", "Failed guardrails", "Category before", "Category after", "Savings before", "Savings after", "Account before", "Account after", "Override reason", "Completed at", "Actual transaction key",
] as const;
export const TRANSFER_HEADERS = [
  "Transfer ID", "Created at", "Created by", "Budget month", "From category", "To category", "Amount", "Reason", "Related plan ID", "Status", "Reversal reference",
] as const;
export const EXPECTED_INCOME_HEADERS = [
  "Expected-income ID", "Created at", "Created by", "Expected date", "Source", "Destination account", "Amount", "Status", "Note",
] as const;
export const SUMMARY_HEADERS = [
  "Category", "Baseline budget", "Transfers in", "Transfers out", "Adjusted budget", "Actual spending", "Active reservations", "Available budget",
] as const;
export const HOUSEHOLD_LABELS = [
  "Actual income", "Confirmed future income", "Total recognized monthly income", "Protected savings target", "Total baseline expense budgets", "Total adjusted expense budgets", "Unallocated headroom", "Funding surplus or shortfall", "Reconciliation status", "Transfer reconciliation", "Planning month", "Planning date",
] as const;
export const PLANNING_SHEETS = [
  { name: "Rencana Pengeluaran", headers: PLAN_HEADERS },
  { name: "Transfer Budget", headers: TRANSFER_HEADERS },
  { name: "Pendapatan Diharapkan", headers: EXPECTED_INCOME_HEADERS },
  { name: "Ringkasan Perencanaan", headers: SUMMARY_HEADERS },
] as const;
export const PLANNING_CAPACITY = 1000;
export const LAST_PLANNING_ROW = PLANNING_CAPACITY + 1;
