import { formatIDR, formatLocalDate } from "../format";
import { renderConfirmDialog, closeConfirmDialog } from "../components/confirm-dialog";
import { renderPurchaseResult } from "./result-view";
import { createExpectedIncomeSection } from "./expected-income-view";
import { createTransferForm } from "./transfers-view";
import { renderCategoryHealth } from "./category-health";
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
 * actions, category health immediately below active reservations, and the expected-income section
 * (see expected-income-view.ts's docstring for why it's mounted here rather than getting its own nav
 * tab).
 *
 * Category health (remaining-amount bars, consumption bars, direct "Transfer budget" action) is
 * rendered here via category-health.ts's shared renderer, immediately below active reservations -
 * spec section 11 places it "immediately below active plans, one short scroll away" in the same
 * section that defines the four-tab nav (Plan/Budgets/Transfers/History), so this tab shows it
 * directly rather than requiring navigation to budgets-view.ts's dedicated tab (which still shows
 * the same data as a fuller view).
 *
 * Active reservations: `bootstrap.activeReservations` (server-provided, survives a page reload)
 * carries each reservation's own `actionId`, so Cancel/Complete act on every active reservation, not
 * only ones created during this browser session. `sessionPlans` is now only a display-enrichment
 * cache (it has the item name/category/status that `ActiveReservationView` doesn't carry) for
 * reservations reserved/overridden earlier in this session; reservations that predate this session
 * (e.g. from before a reload) render with the plainer amount/account/date text but the same
 * Cancel/Complete actions.
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

export function createPlanRenderer(store: Store, api: ApiClient): ViewRenderer {
  let draft = emptyDraft();
  let checkActionId = crypto.randomUUID();
  let checkPending = false;
  let checkError: string | null = null;

  let activeCheck: { proposal: Proposal; before: PlanningStateView; check: PurchaseCheckView } | null = null;
  let resultPending = false;
  let resultError: string | null = null;

  // Plans reserved/overridden/cancelled/completed during this browser session. Cancel/Complete now
  // act on every entry in `bootstrap.activeReservations` (each carries its own server-provided
  // actionId - see this file's docstring), so this is only a display-enrichment cache: it supplies
  // the item name/category/status that `ActiveReservationView` itself doesn't carry, for
  // reservations made earlier in this session.
  let sessionPlans: PlanViewModel[] = [];
  const rowPending = new Set<string>();
  const rowErrors = new Map<string, string>();

  let openTransferFor: string | null = null;
  let categoryTransferForm: ((container: HTMLElement) => void) | null = null;

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

  function cancelReservation(actionId: string): void {
    if (rowPending.has(actionId)) return;
    rowPending.add(actionId);
    rowErrors.delete(actionId);
    rerender();

    api
      .cancelPlan({ actionId })
      .then(({ result, planningState }) => {
        sessionPlans = sessionPlans.some(p => p.actionId === result.actionId)
          ? sessionPlans.map(p => (p.actionId === result.actionId ? result : p))
          : [result, ...sessionPlans];
        rowPending.delete(actionId);
        store.setState({ bootstrap: planningState });
      })
      .catch((error: unknown) => {
        rowPending.delete(actionId);
        rowErrors.set(actionId, describeApiError(error));
        rerender();
      });
  }

  function completeReservation(actionId: string): void {
    if (rowPending.has(actionId)) return;
    rowPending.add(actionId);
    rowErrors.delete(actionId);
    rerender();

    api
      .completePlan({ actionId })
      .then(({ result, planningState }) => {
        sessionPlans = sessionPlans.some(p => p.actionId === result.actionId)
          ? sessionPlans.map(p => (p.actionId === result.actionId ? result : p))
          : [result, ...sessionPlans];
        rowPending.delete(actionId);
        store.setState({ bootstrap: planningState });
      })
      .catch((error: unknown) => {
        rowPending.delete(actionId);
        rowErrors.set(actionId, describeApiError(error));
        rerender();
      });
  }

  function toggleCategoryTransfer(category: string): void {
    if (openTransferFor === category) {
      openTransferFor = null;
      categoryTransferForm = null;
    } else {
      openTransferFor = category;
      categoryTransferForm = createTransferForm(store, api, {
        initialFromCategory: category,
        onDone: () => {
          openTransferFor = null;
          categoryTransferForm = null;
          rerender();
        },
      });
    }
    rerender();
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
        // Enrich with this session's own record of the plan (item/category/status) when available;
        // a reservation carried over from a prior session (e.g. after a reload) only has the
        // amount/account/date the server view model itself carries, but gets the same actions.
        const sessionPlan = sessionPlans.find(p => p.actionId === reservation.actionId);
        const text = document.createElement("span");
        text.textContent = sessionPlan
          ? `${sessionPlan.item}: ${formatIDR(sessionPlan.amount)} (${sessionPlan.category}, ${sessionPlan.paymentAccount}) - ${sessionPlan.status}`
          : `${reservation.item ? `${reservation.item}${reservation.category ? ` (${reservation.category})` : ""}: ` : ""}` +
            `${formatIDR(reservation.amount)} from ${reservation.paymentAccount} on ${formatLocalDate(reservation.plannedDate)}`;
        item.appendChild(text);

        const pending = rowPending.has(reservation.actionId);

        const completeButton = document.createElement("button");
        completeButton.type = "button";
        completeButton.className = "button-secondary";
        completeButton.textContent = "Mark purchased";
        completeButton.disabled = pending;
        const completePanel = document.createElement("div");
        completeButton.addEventListener("click", () => {
          renderConfirmDialog(completePanel, {
            title: "Confirm purchase completed",
            message: sessionPlan
              ? `Record ${formatIDR(sessionPlan.amount)} for ${sessionPlan.item} as actual spending.`
              : `Record ${formatIDR(reservation.amount)} as actual spending.`,
            confirmLabel: "Confirm complete",
            onConfirm: () => {
              closeConfirmDialog(completePanel);
              completeReservation(reservation.actionId);
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
            message: sessionPlan
              ? `Release the ${formatIDR(sessionPlan.amount)} reserved for ${sessionPlan.item}.`
              : `Release the ${formatIDR(reservation.amount)} reserved.`,
            confirmLabel: "Confirm cancel",
            onConfirm: () => {
              closeConfirmDialog(cancelPanel);
              cancelReservation(reservation.actionId);
            },
            onCancel: () => closeConfirmDialog(cancelPanel),
          });
        });
        item.append(cancelButton, cancelPanel);

        const rowError = rowErrors.get(reservation.actionId);
        if (rowError) {
          const error = document.createElement("p");
          error.className = "error-text";
          error.textContent = rowError;
          item.appendChild(error);
        }

        list.appendChild(item);
      }
      reservations.appendChild(list);
    }

    container.appendChild(reservations);

    const categoryHealth = document.createElement("section");
    const categoryHealthHeading = document.createElement("h2");
    categoryHealthHeading.textContent = "Category health";
    categoryHealth.appendChild(categoryHealthHeading);
    const categoryHealthList = document.createElement("div");
    renderCategoryHealth(categoryHealthList, bootstrap.categories, {
      openTransferFor,
      transferForm: categoryTransferForm,
      onToggleTransfer: toggleCategoryTransfer,
    });
    categoryHealth.appendChild(categoryHealthList);
    container.appendChild(categoryHealth);

    const incomeContainer = document.createElement("div");
    renderExpectedIncome(incomeContainer);
    container.appendChild(incomeContainer);
  }

  return (container, state) => {
    renderBody(container, state);
  };
}
