import { formatIDR, formatLocalDate } from "../format";
import { renderConfirmDialog, closeConfirmDialog } from "../components/confirm-dialog";
import { renderPurchaseResult } from "./result-view";
import { createExpectedIncomeSection } from "./expected-income-view";
import { PROTECTED_SAVINGS_CATEGORY } from "../../domain/transfers";
import type { Store } from "../state";
import type { ApiClient, ApiError } from "../api";
import type { ClientState } from "../state";
import type { ViewRenderer } from "../render";
import type { Proposal } from "../../domain/types";
import type { PlanningStateView, PlanView as PlanViewModel, PurchaseCheckView } from "../../server/view-models";

/**
 * The Plan tab (spec section 11 "Home / Plan"): decision-first first viewport (protected savings,
 * funded amount, safe-to-plan amount, days remaining), the "Check a purchase" flow (which shows
 * result-view.ts's screen inline once a check comes back), active reservations with cancel/complete
 * actions, and the expected-income section (see expected-income-view.ts's docstring for why it's
 * mounted here rather than getting its own nav tab).
 *
 * Category health with remaining-amount bars lives on budgets-view.ts, its own dedicated tab - see
 * that file's docstring for why this task reads spec section 11's "one short scroll away" as
 * describing the pre-tab-split mockup rather than this task's four-tab architecture.
 */

interface ProposalDraft {
  item: string;
  amount: string;
  category: string;
  plannedDate: string;
  paymentAccount: string;
}

function emptyDraft(): ProposalDraft {
  return { item: "", amount: "", category: "", plannedDate: "", paymentAccount: "" };
}

function describeApiError(error: unknown): string {
  const apiError = error as ApiError;
  return apiError?.message ?? "Something went wrong. Please try again.";
}

function appendSummaryRow(list: HTMLDListElement, label: string, value: string): void {
  const dt = document.createElement("dt");
  dt.textContent = label;
  const dd = document.createElement("dd");
  dd.textContent = value;
  list.append(dt, dd);
}

function isActivePlan(plan: PlanViewModel): boolean {
  return plan.status === "RESERVED" || plan.status === "OVERRIDDEN";
}

export function createPlanRenderer(store: Store, api: ApiClient): ViewRenderer {
  let draft = emptyDraft();
  let checkActionId = crypto.randomUUID();
  let checkPending = false;
  let checkError: string | null = null;

  let activeCheck: { proposal: Proposal; before: PlanningStateView; check: PurchaseCheckView } | null = null;
  let resultPending = false;
  let resultError: string | null = null;

  // Plans reserved/overridden/cancelled/completed during this browser session, tracked locally so
  // Cancel/Complete has an actionId to call - see this file's docstring and
  // expected-income-view.ts's "Known limitation" note: bootstrap's ActiveReservationView carries no
  // actionId, and getHistoryRpc only returns terminal-status plans, so there is no bulk endpoint
  // that lists actionable active plans.
  let sessionPlans: PlanViewModel[] = [];
  const rowPending = new Set<string>();
  const rowErrors = new Map<string, string>();

  const renderExpectedIncome = createExpectedIncomeSection(store, api);

  let currentContainer: HTMLElement | null = null;

  function rerender(): void {
    if (currentContainer) renderBody(currentContainer, store.getState());
  }

  function toProposal(bootstrap: PlanningStateView): Proposal | null {
    const amount = Number(draft.amount);
    if (
      !draft.item.trim() ||
      !draft.category ||
      !draft.paymentAccount ||
      !draft.plannedDate ||
      !Number.isFinite(amount) ||
      amount <= 0
    ) {
      return null;
    }
    void bootstrap;
    return {
      actionId: checkActionId,
      item: draft.item.trim(),
      amount: amount as Proposal["amount"],
      category: draft.category,
      plannedDate: draft.plannedDate as Proposal["plannedDate"],
      paymentAccount: draft.paymentAccount,
    };
  }

  function submitCheck(bootstrap: PlanningStateView): void {
    const proposal = toProposal(bootstrap);
    if (!proposal) {
      checkError = "Enter an item, amount, category, date, and payment account.";
      rerender();
      return;
    }
    checkPending = true;
    checkError = null;
    rerender();

    api
      .checkPurchase(proposal)
      .then(check => {
        checkPending = false;
        activeCheck = { proposal, before: bootstrap, check };
        resultError = null;
        rerender();
      })
      .catch((error: unknown) => {
        checkPending = false;
        checkError = describeApiError(error);
        rerender();
      });
  }

  function discardCheck(): void {
    activeCheck = null;
    resultError = null;
    checkActionId = crypto.randomUUID();
    rerender();
  }

  function useLowerPrice(amount: number): void {
    draft = { ...draft, amount: String(amount) };
    activeCheck = null;
    rerender();
  }

  function useAccount(account: string): void {
    draft = { ...draft, paymentAccount: account };
    activeCheck = null;
    rerender();
  }

  function goToTransfers(): void {
    activeCheck = null;
    store.setState({ view: "transfers" });
  }

  function reserve(): void {
    if (!activeCheck) return;
    resultPending = true;
    resultError = null;
    rerender();

    api
      .reservePurchase(activeCheck.proposal)
      .then(({ result, planningState }) => {
        sessionPlans = [result, ...sessionPlans];
        activeCheck = null;
        draft = emptyDraft();
        checkActionId = crypto.randomUUID();
        resultPending = false;
        store.setState({ bootstrap: planningState });
      })
      .catch((error: unknown) => {
        resultPending = false;
        resultError = describeApiError(error);
        rerender();
      });
  }

  function override(reason: string): void {
    if (!activeCheck) return;
    resultPending = true;
    resultError = null;
    rerender();

    api
      .overridePurchase({ ...activeCheck.proposal, reason })
      .then(({ result, planningState }) => {
        sessionPlans = [result, ...sessionPlans];
        activeCheck = null;
        draft = emptyDraft();
        checkActionId = crypto.randomUUID();
        resultPending = false;
        store.setState({ bootstrap: planningState });
      })
      .catch((error: unknown) => {
        resultPending = false;
        resultError = describeApiError(error);
        rerender();
      });
  }

  function cancelReservation(plan: PlanViewModel): void {
    if (rowPending.has(plan.actionId)) return;
    rowPending.add(plan.actionId);
    rowErrors.delete(plan.actionId);
    rerender();

    api
      .cancelPlan({ actionId: plan.actionId })
      .then(({ result, planningState }) => {
        sessionPlans = sessionPlans.map(p => (p.actionId === result.actionId ? result : p));
        rowPending.delete(plan.actionId);
        store.setState({ bootstrap: planningState });
      })
      .catch((error: unknown) => {
        rowPending.delete(plan.actionId);
        rowErrors.set(plan.actionId, describeApiError(error));
        rerender();
      });
  }

  function completeReservation(plan: PlanViewModel): void {
    if (rowPending.has(plan.actionId)) return;
    rowPending.add(plan.actionId);
    rowErrors.delete(plan.actionId);
    rerender();

    api
      .completePlan({ actionId: plan.actionId })
      .then(({ result, planningState }) => {
        sessionPlans = sessionPlans.map(p => (p.actionId === result.actionId ? result : p));
        rowPending.delete(plan.actionId);
        store.setState({ bootstrap: planningState });
      })
      .catch((error: unknown) => {
        rowPending.delete(plan.actionId);
        rowErrors.set(plan.actionId, describeApiError(error));
        rerender();
      });
  }

  function renderBody(container: HTMLElement, state: ClientState): void {
    currentContainer = container;
    container.replaceChildren();

    const bootstrap = state.bootstrap;
    if (!bootstrap) return;

    const summary = document.createElement("dl");
    summary.className = "summary";
    appendSummaryRow(summary, "Protected savings", formatIDR(bootstrap.protectedSavings));
    appendSummaryRow(summary, "Funded amount", formatIDR(bootstrap.fundedAmount));
    appendSummaryRow(summary, "Safe to plan", formatIDR(bootstrap.safeToPlanAmount));
    appendSummaryRow(summary, "Days remaining", String(bootstrap.daysRemaining));
    container.appendChild(summary);

    const formSection = document.createElement("section");
    const formHeading = document.createElement("h2");
    formHeading.textContent = "Check a purchase";
    formSection.appendChild(formHeading);

    const form = document.createElement("form");
    form.setAttribute("aria-label", "Check a purchase");
    form.addEventListener("submit", event => {
      event.preventDefault();
      submitCheck(bootstrap);
    });

    const itemField = document.createElement("div");
    itemField.className = "field";
    const itemLabel = document.createElement("label");
    itemLabel.htmlFor = "plan-item";
    itemLabel.textContent = "Item";
    const itemInput = document.createElement("input");
    itemInput.id = "plan-item";
    itemInput.type = "text";
    itemInput.value = draft.item;
    itemInput.addEventListener("input", () => (draft = { ...draft, item: itemInput.value }));
    itemField.append(itemLabel, itemInput);
    form.appendChild(itemField);

    const amountField = document.createElement("div");
    amountField.className = "field";
    const amountLabel = document.createElement("label");
    amountLabel.htmlFor = "plan-amount";
    amountLabel.textContent = "Amount";
    const amountInput = document.createElement("input");
    amountInput.id = "plan-amount";
    amountInput.type = "number";
    amountInput.min = "1";
    amountInput.value = draft.amount;
    amountInput.addEventListener("input", () => (draft = { ...draft, amount: amountInput.value }));
    amountField.append(amountLabel, amountInput);
    form.appendChild(amountField);

    const categoryField = document.createElement("div");
    categoryField.className = "field";
    const categoryLabel = document.createElement("label");
    categoryLabel.htmlFor = "plan-category";
    categoryLabel.textContent = "Category";
    const categorySelect = document.createElement("select");
    categorySelect.id = "plan-category";
    const categoryBlank = document.createElement("option");
    categoryBlank.value = "";
    categoryBlank.textContent = "Select a category";
    categorySelect.appendChild(categoryBlank);
    // Savings is a locked envelope, not an expense category (spec section 7) - never selectable here.
    for (const category of bootstrap.categories.filter(c => c.category !== PROTECTED_SAVINGS_CATEGORY)) {
      const option = document.createElement("option");
      option.value = category.category;
      option.textContent = category.category;
      categorySelect.appendChild(option);
    }
    categorySelect.value = draft.category;
    categorySelect.addEventListener("change", () => (draft = { ...draft, category: categorySelect.value }));
    categoryField.append(categoryLabel, categorySelect);
    form.appendChild(categoryField);

    const dateField = document.createElement("div");
    dateField.className = "field";
    const dateLabel = document.createElement("label");
    dateLabel.htmlFor = "plan-date";
    dateLabel.textContent = "Planned date";
    const dateInput = document.createElement("input");
    dateInput.id = "plan-date";
    dateInput.type = "date";
    dateInput.value = draft.plannedDate;
    dateInput.addEventListener("input", () => (draft = { ...draft, plannedDate: dateInput.value }));
    dateField.append(dateLabel, dateInput);
    form.appendChild(dateField);

    const accountField = document.createElement("div");
    accountField.className = "field";
    const accountLabel = document.createElement("label");
    accountLabel.htmlFor = "plan-account";
    accountLabel.textContent = "Payment account";
    const accountSelect = document.createElement("select");
    accountSelect.id = "plan-account";
    const accountBlank = document.createElement("option");
    accountBlank.value = "";
    accountBlank.textContent = "Select an account";
    accountSelect.appendChild(accountBlank);
    for (const account of bootstrap.accounts) {
      const option = document.createElement("option");
      option.value = account.account;
      option.textContent = account.account;
      accountSelect.appendChild(option);
    }
    accountSelect.value = draft.paymentAccount;
    accountSelect.addEventListener("change", () => (draft = { ...draft, paymentAccount: accountSelect.value }));
    accountField.append(accountLabel, accountSelect);
    form.appendChild(accountField);

    const submitButton = document.createElement("button");
    submitButton.type = "submit";
    submitButton.className = "button-primary";
    submitButton.textContent = "Check this purchase";
    submitButton.disabled = checkPending;
    form.appendChild(submitButton);

    if (checkError) {
      const error = document.createElement("p");
      error.className = "error-text";
      error.textContent = checkError;
      form.appendChild(error);
    }

    formSection.appendChild(form);
    container.appendChild(formSection);

    if (activeCheck) {
      const resultContainer = document.createElement("div");
      renderPurchaseResult(resultContainer, {
        proposal: activeCheck.proposal,
        before: activeCheck.before,
        check: activeCheck.check,
        pending: resultPending,
        submitError: resultError,
        onReserve: reserve,
        onOverride: override,
        onUseLowerPrice: useLowerPrice,
        onUseAccount: useAccount,
        onGoToTransfers: goToTransfers,
        onDiscard: discardCheck,
      });
      container.appendChild(resultContainer);
    }

    const reservations = document.createElement("section");
    const reservationsHeading = document.createElement("h2");
    reservationsHeading.textContent = "Active reservations";
    reservations.appendChild(reservationsHeading);

    if (bootstrap.activeReservations.length === 0) {
      const empty = document.createElement("p");
      empty.textContent = "No active reservations yet.";
      reservations.appendChild(empty);
    } else {
      const list = document.createElement("ul");
      for (const reservation of bootstrap.activeReservations) {
        const item = document.createElement("li");
        item.textContent =
          `${formatIDR(reservation.amount)} from ${reservation.paymentAccount} on ${formatLocalDate(reservation.plannedDate)}`;
        list.appendChild(item);
      }
      reservations.appendChild(list);
    }

    const actionablePlans = sessionPlans.filter(isActivePlan);
    if (actionablePlans.length > 0) {
      const actionableHeading = document.createElement("h3");
      actionableHeading.textContent = "Manage this session's reservations";
      reservations.appendChild(actionableHeading);

      const actionableList = document.createElement("ul");
      for (const plan of actionablePlans) {
        const item = document.createElement("li");
        const text = document.createElement("span");
        text.textContent = `${plan.item}: ${formatIDR(plan.amount)} (${plan.category}, ${plan.paymentAccount}) - ${plan.status}`;
        item.appendChild(text);

        const pending = rowPending.has(plan.actionId);

        const completeButton = document.createElement("button");
        completeButton.type = "button";
        completeButton.className = "button-secondary";
        completeButton.textContent = "Mark purchased";
        completeButton.disabled = pending;
        const completePanel = document.createElement("div");
        completeButton.addEventListener("click", () => {
          renderConfirmDialog(completePanel, {
            title: "Confirm purchase completed",
            message: `Record ${formatIDR(plan.amount)} for ${plan.item} as actual spending.`,
            confirmLabel: "Confirm complete",
            onConfirm: () => {
              closeConfirmDialog(completePanel);
              completeReservation(plan);
            },
            onCancel: () => closeConfirmDialog(completePanel),
          });
        });
        item.append(completeButton, completePanel);

        const cancelButton = document.createElement("button");
        cancelButton.type = "button";
        cancelButton.className = "button-secondary";
        cancelButton.textContent = "Cancel reservation";
        cancelButton.disabled = pending;
        const cancelPanel = document.createElement("div");
        cancelButton.addEventListener("click", () => {
          renderConfirmDialog(cancelPanel, {
            title: "Confirm cancel reservation",
            message: `Release the ${formatIDR(plan.amount)} reserved for ${plan.item}.`,
            confirmLabel: "Confirm cancel",
            onConfirm: () => {
              closeConfirmDialog(cancelPanel);
              cancelReservation(plan);
            },
            onCancel: () => closeConfirmDialog(cancelPanel),
          });
        });
        item.append(cancelButton, cancelPanel);

        const rowError = rowErrors.get(plan.actionId);
        if (rowError) {
          const error = document.createElement("p");
          error.className = "error-text";
          error.textContent = rowError;
          item.appendChild(error);
        }

        actionableList.appendChild(item);
      }
      reservations.appendChild(actionableList);
    }

    container.appendChild(reservations);

    const incomeContainer = document.createElement("div");
    renderExpectedIncome(incomeContainer);
    container.appendChild(incomeContainer);
  }

  return (container, state) => {
    renderBody(container, state);
  };
}
