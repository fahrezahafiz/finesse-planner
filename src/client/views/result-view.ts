import { formatIDR, formatLocalDate } from "../format";
import { renderConfirmDialog, closeConfirmDialog } from "../components/confirm-dialog";
import type { Proposal } from "../../domain/types";
import type { CorrectionView, PlanningStateView, PurchaseCheckView } from "../../server/view-models";

/**
 * Presentational purchase-result screen (spec section 7 "Strict recommendation model" and section
 * 11 "Purchase result"). Not a registered ViewName - `ClientState["view"]` only has the four nav
 * destinations (plan/budgets/transfers/history), so this renders as a section *inside* plan-view's
 * container after a check, the same way expected-income-view.ts is a section rather than a tab.
 *
 * Every number shown here comes from already-fetched, server-validated view-model data
 * (PurchaseCheckView from api.checkPurchase, plus the PlanningStateView already sitting in the
 * store from bootstrap/last mutation) - the only client-side arithmetic here is the "with this
 * purchase" category/account deltas the task's Global Constraints explicitly call for, computed
 * from those already-validated numbers for a read-only display, never for a mutation.
 */
export interface PurchaseResultProps {
  readonly proposal: Proposal;
  /** The planning state as it stood before this proposed purchase - the "without" side of the comparison. */
  readonly before: PlanningStateView;
  readonly check: PurchaseCheckView;
  readonly pending: boolean;
  readonly submitError: string | null;
  readonly onReserve: () => void;
  readonly onOverride: (reason: string) => void;
  readonly onUseLowerPrice: (amount: number) => void;
  readonly onUseAccount: (account: string) => void;
  readonly onGoToTransfers: () => void;
  readonly onDiscard: () => void;
}

const VERDICT_TEXT: Record<PurchaseCheckView["decision"]["verdict"], string> = {
  RECOMMENDED: "Recommended",
  NOT_RECOMMENDED: "Not recommended",
  UNABLE_TO_EVALUATE: "Unable to evaluate right now",
};

const GUARDRAIL_LABELS: Record<string, string> = {
  PLANNING_MONTH_HEALTH: "This month's plan is not fully funded yet.",
  CATEGORY_AVAILABILITY: "category-availability",
  PROTECTED_SAVINGS: "Protected savings would fall below its target.",
  ACCOUNT_LIQUIDITY: "account-liquidity",
  SCHEMA_AND_FORMULA_HEALTH: "The workbook needs attention before this can be evaluated.",
};

function describeGuardrail(name: string, proposal: Proposal, shortfall: number): string {
  if (name === "CATEGORY_AVAILABILITY") {
    return `${proposal.category} budget is short by ${formatIDR(shortfall)}.`;
  }
  if (name === "ACCOUNT_LIQUIDITY") {
    return `${proposal.paymentAccount} balance would go negative by ${formatIDR(shortfall)}.`;
  }
  return GUARDRAIL_LABELS[name] ?? name;
}

function describeCorrection(correction: CorrectionView): string {
  switch (correction.kind) {
    case "LOWER_PRICE":
      return `Lower the price to ${formatIDR(correction.amount)}.`;
    case "TRANSFER":
      return `Transfer ${formatIDR(correction.amount)} from ${correction.fromCategory} to ${correction.toCategory}.`;
    case "ALTERNATE_ACCOUNT":
      return `Pay from ${correction.paymentAccount} instead.`;
    case "WAIT_FOR_INCOME":
      return `Wait until ${formatLocalDate(correction.expectedDate)}, when confirmed income arrives.`;
  }
}

function appendRow(dl: HTMLDListElement, label: string, value: string, danger = false): void {
  const dt = document.createElement("dt");
  dt.textContent = label;
  const dd = document.createElement("dd");
  dd.textContent = value;
  if (danger) dd.className = "error-text";
  dl.append(dt, dd);
}

export function renderPurchaseResult(container: HTMLElement, props: PurchaseResultProps): void {
  container.replaceChildren();
  const { proposal, before, check, pending } = props;
  const { decision, corrections } = check;

  const section = document.createElement("section");
  section.className = "purchase-result";

  const verdict = document.createElement("p");
  verdict.className = decision.verdict === "RECOMMENDED" ? "verdict-ok" : "verdict-bad";
  verdict.textContent = `Verdict: ${VERDICT_TEXT[decision.verdict]}`;
  section.appendChild(verdict);

  if (decision.failedGuardrails.length > 0) {
    const heading = document.createElement("h3");
    heading.textContent = "What's blocking this";
    section.appendChild(heading);

    const list = document.createElement("ul");
    for (const name of decision.failedGuardrails) {
      const item = document.createElement("li");
      const shortfall =
        name === "CATEGORY_AVAILABILITY"
          ? decision.category.shortfall
          : name === "ACCOUNT_LIQUIDITY"
            ? decision.account.shortfall
            : name === "PROTECTED_SAVINGS"
              ? decision.savings.shortfall
              : 0;
      item.textContent = describeGuardrail(name, proposal, shortfall);
      if (name === decision.firstFailure) item.className = "error-text";
      list.appendChild(item);
    }
    section.appendChild(list);
  }

  // With/without comparison (Global Constraints: show category/savings/household/account state
  // with vs. without the proposed purchase). "Without" is the current PlanningStateView; "with" for
  // the category and account rows is computed here since a passing GuardrailResult always carries
  // shortfall: 0 (it doesn't encode the post-purchase remaining margin) - the household/savings
  // rows reuse the server's own post-purchase guardrail comparison directly.
  const comparisonHeading = document.createElement("h3");
  comparisonHeading.textContent = "With and without this purchase";
  section.appendChild(comparisonHeading);

  const comparison = document.createElement("dl");
  comparison.className = "summary";
  const serverComparison = check.comparison;

  const beforeCategory = before.categories.find(c => c.category === proposal.category);
  if (beforeCategory) {
    const withoutAvailable = serverComparison?.categoryWithout ?? beforeCategory.availableBudget;
    const afterAvailable = serverComparison?.categoryWith ?? (beforeCategory.availableBudget - proposal.amount);
    appendRow(comparison, `${proposal.category} budget (without)`, formatIDR(withoutAvailable));
    appendRow(
      comparison,
      `${proposal.category} budget (with)`,
      afterAvailable >= 0 ? formatIDR(afterAvailable) : `short by ${formatIDR(-afterAvailable)}`,
      afterAvailable < 0,
    );
  }

  if (serverComparison) {
    appendRow(comparison, "Projected savings (without)", formatIDR(serverComparison.savingsWithout));
    appendRow(comparison, "Projected savings (with)", formatIDR(serverComparison.savingsWith), !decision.savings.passed);
  } else {
    appendRow(comparison, "Protected savings (with this purchase)", decision.savings.passed ? "Meets target" : `Short by ${formatIDR(decision.savings.shortfall)}`, !decision.savings.passed);
  }

  if (serverComparison) {
    appendRow(comparison, "Household headroom (without)", formatIDR(serverComparison.householdWithout));
    appendRow(comparison, "Household headroom (with)", formatIDR(serverComparison.householdWith), !decision.household.passed);
  } else {
    appendRow(comparison, "Household funding (with this purchase)", decision.household.passed ? "Within headroom" : `Short by ${formatIDR(decision.household.shortfall)}`, !decision.household.passed);
  }

  const beforeAccount = before.accounts.find(a => a.account === proposal.paymentAccount);
  if (beforeAccount) {
    const withoutBalance = serverComparison?.accountWithout ?? beforeAccount.currentBalance;
    const afterBalance = serverComparison?.accountWith ?? (beforeAccount.currentBalance - proposal.amount);
    appendRow(comparison, `${proposal.paymentAccount} balance (without)`, formatIDR(withoutBalance));
    appendRow(
      comparison,
      `${proposal.paymentAccount} balance (with)`,
      afterBalance >= 0 ? formatIDR(afterBalance) : `short by ${formatIDR(-afterBalance)}`,
      !decision.account.passed,
    );
  }

  section.appendChild(comparison);

  const allowance = document.createElement("p");
  allowance.textContent = `Safe daily allowance through month-end: ${formatIDR(decision.safeDailyAllowance)}`;
  section.appendChild(allowance);

  if (corrections.length > 0) {
    const correctionsHeading = document.createElement("h3");
    correctionsHeading.textContent = "Ways to make this work";
    section.appendChild(correctionsHeading);

    const list = document.createElement("ol");
    for (const correction of corrections) {
      const item = document.createElement("li");
      const text = document.createElement("span");
      text.textContent = describeCorrection(correction);
      item.appendChild(text);

      if (correction.kind === "LOWER_PRICE") {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "button-secondary";
        button.textContent = `Use ${formatIDR(correction.amount)}`;
        button.disabled = pending;
        button.addEventListener("click", () => props.onUseLowerPrice(correction.amount));
        item.appendChild(button);
      } else if (correction.kind === "ALTERNATE_ACCOUNT") {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "button-secondary";
        button.textContent = `Use ${correction.paymentAccount}`;
        button.disabled = pending;
        button.addEventListener("click", () => props.onUseAccount(correction.paymentAccount));
        item.appendChild(button);
      } else if (correction.kind === "TRANSFER") {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "button-secondary";
        button.textContent = "Go to Transfers";
        button.disabled = pending;
        button.addEventListener("click", () => props.onGoToTransfers());
        item.appendChild(button);
      }

      list.appendChild(item);
    }
    section.appendChild(list);
  }

  if (props.submitError) {
    const error = document.createElement("p");
    error.className = "error-text";
    error.textContent = props.submitError;
    section.appendChild(error);
  }

  const actions = document.createElement("div");
  actions.className = "result-actions";

  if (decision.verdict === "RECOMMENDED") {
    const reserveButton = document.createElement("button");
    reserveButton.type = "button";
    reserveButton.className = "button-primary";
    reserveButton.textContent = "Reserve this purchase";
    reserveButton.disabled = pending;
    reserveButton.addEventListener("click", () => props.onReserve());
    actions.appendChild(reserveButton);
  }

  const overridePanel = document.createElement("div");
  overridePanel.className = "confirm-panel-host";

  if (decision.verdict !== "RECOMMENDED") {
    const overrideButton = document.createElement("button");
    overrideButton.type = "button";
    overrideButton.className = "button-secondary button-caution";
    overrideButton.textContent = "Save with override";
    overrideButton.disabled = pending;
    overrideButton.addEventListener("click", () => {
      renderConfirmDialog(overridePanel, {
        title: "Confirm override",
        message: "Saving this override reserves the amount even though it failed a guardrail. This cannot be undone automatically.",
        confirmLabel: "Confirm override",
        reasonLabel: "Reason",
        onConfirm: reason => props.onOverride(reason),
        onCancel: () => closeConfirmDialog(overridePanel),
      });
    });
    actions.appendChild(overrideButton);
  }

  const discardButton = document.createElement("button");
  discardButton.type = "button";
  discardButton.className = "button-secondary";
  discardButton.textContent = "Start over";
  discardButton.disabled = pending;
  discardButton.addEventListener("click", () => props.onDiscard());
  actions.appendChild(discardButton);

  section.appendChild(actions);
  section.appendChild(overridePanel);

  container.appendChild(section);
}
