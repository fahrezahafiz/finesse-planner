import { formatIDR, formatLocalDate } from "../format";
import { renderConfirmDialog, closeConfirmDialog } from "../components/confirm-dialog";
import { PROTECTED_SAVINGS_CATEGORY } from "../../domain/transfers";
import type { Store } from "../state";
import type { ApiClient, ApiError } from "../api";
import type { ViewRenderer } from "../render";
import type {
  CategoryBudgetView,
  HistoryView,
  InsightsView,
  PlanningStateView,
  RecurringCategoryPatternView,
  TransferView,
} from "../../server/view-models";

/**
 * The Transfers tab (spec sections 9-10, 11 "Transfers and patterns"): current-month transfer
 * activity plus historical pattern insights, separated as the spec asks ("Separate current-month
 * transfers from historical insights"). Reversed transfers (the past-tense record) also appear here
 * via api.getHistory() rather than on History, matching the resolved decision recorded in
 * plan-view.ts's docstring: insights and transfer activity both live on this tab.
 *
 * `createTransferForm` is exported and reused by budgets-view.ts's direct "Transfer budget" action
 * per category (see budgets-view.ts) - the one shared helper this task needed, kept in this file
 * rather than a new module since transfers-view.ts is the form's natural owner.
 *
 * Active transfers come from authoritative bootstrap state, with session results retained only
 * until a refreshed state arrives.
 */

function describeApiError(error: unknown): string {
  const apiError = error as ApiError;
  return apiError?.message ?? "Something went wrong. Please try again.";
}

export interface TransferFormOptions {
  readonly initialFromCategory?: string;
  readonly onDone?: (result: TransferView) => void;
}

/** A donor/recipient <select> that always excludes protected savings (never a transfer category). */
function appendCategoryOptions(select: HTMLSelectElement, categories: readonly CategoryBudgetView[]): void {
  const blank = document.createElement("option");
  blank.value = "";
  blank.textContent = "Select a category";
  select.appendChild(blank);
  for (const category of categories) {
    if (category.category === PROTECTED_SAVINGS_CATEGORY) continue;
    const option = document.createElement("option");
    option.value = category.category;
    option.textContent = category.category;
    select.appendChild(option);
  }
}

/** Builds a reusable transfer-creation form. Returned function re-renders into whatever container it's given each call. */
export function createTransferForm(store: Store, api: ApiClient, options: TransferFormOptions = {}): (container: HTMLElement) => void {
  let draft = { fromCategory: options.initialFromCategory ?? "", toCategory: "", amount: "", reason: "" };
  let actionId = crypto.randomUUID();
  let pending = false;
  let error: string | null = null;
  let currentContainer: HTMLElement | null = null;

  function rerender(): void {
    if (currentContainer) render(currentContainer);
  }

  function categories(): readonly CategoryBudgetView[] {
    return store.getState().bootstrap?.categories ?? [];
  }

  function donorAvailable(): number | null {
    const found = categories().find(c => c.category === draft.fromCategory);
    return found ? found.availableBudget : null;
  }

  function submit(): void {
    const amount = Number(draft.amount);
    if (!draft.fromCategory || !draft.toCategory || draft.fromCategory === draft.toCategory || !Number.isFinite(amount) || amount <= 0) {
      error = "Choose two different categories and a positive amount.";
      rerender();
      return;
    }
    pending = true;
    error = null;
    rerender();

    api
      .createTransfer({
        actionId,
        fromCategory: draft.fromCategory,
        toCategory: draft.toCategory,
        amount: amount as never,
        reason: draft.reason.trim(),
        relatedPlanId: "",
      })
      .then(({ result, planningState }) => {
        pending = false;
        draft = { fromCategory: "", toCategory: "", amount: "", reason: "" };
        actionId = crypto.randomUUID();
        store.setState({ bootstrap: planningState });
        options.onDone?.(result);
      })
      .catch((err: unknown) => {
        pending = false;
        error = describeApiError(err);
        rerender();
      });
  }

  function render(container: HTMLElement): void {
    currentContainer = container;
    container.replaceChildren();

    const form = document.createElement("form");
    form.setAttribute("aria-label", "Create a transfer");
    form.addEventListener("submit", event => event.preventDefault());

    const fromField = document.createElement("div");
    fromField.className = "field";
    const fromLabel = document.createElement("label");
    fromLabel.htmlFor = "transfer-from";
    fromLabel.textContent = "From category";
    const fromSelect = document.createElement("select");
    fromSelect.id = "transfer-from";
    appendCategoryOptions(fromSelect, categories());
    fromSelect.value = draft.fromCategory;
    fromSelect.addEventListener("change", () => {
      draft = { ...draft, fromCategory: fromSelect.value };
      rerender();
    });
    fromField.append(fromLabel, fromSelect);
    form.appendChild(fromField);

    const available = donorAvailable();
    if (draft.fromCategory && available !== null) {
      const availabilityNote = document.createElement("p");
      availabilityNote.className = "muted";
      availabilityNote.textContent = `${draft.fromCategory} has ${formatIDR(available)} available.`;
      form.appendChild(availabilityNote);
    }

    const toField = document.createElement("div");
    toField.className = "field";
    const toLabel = document.createElement("label");
    toLabel.htmlFor = "transfer-to";
    toLabel.textContent = "To category";
    const toSelect = document.createElement("select");
    toSelect.id = "transfer-to";
    appendCategoryOptions(toSelect, categories());
    toSelect.value = draft.toCategory;
    toSelect.addEventListener("change", () => (draft = { ...draft, toCategory: toSelect.value }));
    toField.append(toLabel, toSelect);
    form.appendChild(toField);

    const amountField = document.createElement("div");
    amountField.className = "field";
    const amountLabel = document.createElement("label");
    amountLabel.htmlFor = "transfer-amount";
    amountLabel.textContent = "Amount";
    const amountInput = document.createElement("input");
    amountInput.id = "transfer-amount";
    amountInput.type = "number";
    amountInput.min = "1";
    amountInput.value = draft.amount;
    amountInput.addEventListener("input", () => (draft = { ...draft, amount: amountInput.value }));
    amountField.append(amountLabel, amountInput);
    form.appendChild(amountField);

    const reasonField = document.createElement("div");
    reasonField.className = "field";
    const reasonLabel = document.createElement("label");
    reasonLabel.htmlFor = "transfer-reason";
    reasonLabel.textContent = "Reason";
    const reasonInput = document.createElement("input");
    reasonInput.id = "transfer-reason";
    reasonInput.type = "text";
    reasonInput.value = draft.reason;
    reasonInput.addEventListener("input", () => (draft = { ...draft, reason: reasonInput.value }));
    reasonField.append(reasonLabel, reasonInput);
    form.appendChild(reasonField);

    const confirmHost = document.createElement("div");
    confirmHost.className = "confirm-panel-host";

    const submitButton = document.createElement("button");
    submitButton.type = "button";
    submitButton.className = "button-primary";
    submitButton.textContent = "Create transfer";
    submitButton.disabled = pending;
    submitButton.addEventListener("click", () => {
      const amount = Number(draft.amount);
      const availabilityText =
        draft.fromCategory && available !== null
          ? `${draft.fromCategory} currently has ${formatIDR(available)} available. `
          : "";
      renderConfirmDialog(confirmHost, {
        title: "Confirm transfer",
        message: `${availabilityText}Move ${Number.isFinite(amount) ? formatIDR(amount) : "this amount"} from ${draft.fromCategory || "?"} to ${draft.toCategory || "?"}.`,
        confirmLabel: "Confirm transfer",
        onConfirm: () => {
          closeConfirmDialog(confirmHost);
          submit();
        },
        onCancel: () => closeConfirmDialog(confirmHost),
      });
    });
    form.appendChild(submitButton);
    form.appendChild(confirmHost);

    if (error) {
      const errorText = document.createElement("p");
      errorText.className = "error-text";
      errorText.textContent = error;
      form.appendChild(errorText);
    }

    container.appendChild(form);
  }

  return render;
}

function patternCard(pattern: RecurringCategoryPatternView): HTMLLIElement {
  const item = document.createElement("li");
  item.className = "card";
  const text = document.createElement("p");
  text.textContent =
    `${pattern.category}: ${pattern.frequency} of the last 6 closed months, ` +
    `total ${formatIDR(pattern.total)}, average ${formatIDR(pattern.averageMonthlyNet)}/month`;
  item.appendChild(text);
  return item;
}

interface ReviewDraft {
  expectedAmount: string;
  newAmount: string;
}

export function createTransfersRenderer(store: Store, api: ApiClient): ViewRenderer {
  let history: HistoryView | null = null;
  let insights: InsightsView | null = null;
  let loadStarted = false;
  let loadError: string | null = null;
  // See history-view.ts's matching field: without this, a mutation that changes the store's
  // bootstrap (e.g. reversing a transfer) never invalidates this cache, so the just-reversed
  // transfer's history/insights stay stale until a full page reload.
  let loadedForBootstrap: PlanningStateView | null = null;

  // See this file's "Known limitation" note.
  let sessionTransfers: TransferView[] = [];
  const rowPending = new Set<string>();
  const rowErrors = new Map<string, string>();
  // One reversal actionId per pending reversal row, keyed by the transfer being reversed - hoisted
  // out here (rather than generated inline at the api.reverseTransfer() call site) so a failed
  // reversal's retry reuses the same actionId, matching every other mutation flow in this file.
  const reversalActionIds = new Map<string, string>();

  let showCreateForm = false;
  const createForm = createTransferForm(store, api, {
    onDone: result => {
      sessionTransfers = [result, ...sessionTransfers];
      showCreateForm = false;
      rerender();
    },
  });

  // The review-only baseline suggestion never applies automatically (spec section 10). Because
  // Task 11's view models never expose a category's current baseline amount to the client (only
  // adjustedBudget/availableBudget - see this file's report entry for the full reasoning), the
  // authorized reviewer - who can see the real Atur Budgeting sheet - types the expected current
  // amount and the new amount themselves; this is also consistent with the plan's global
  // constraint that the client must never invent the numbers behind a financial mutation.
  let reviewDrafts = new Map<string, ReviewDraft>();
  let reviewPending = false;
  let reviewError: string | null = null;
  let reviewResultNote: string | null = null;
  // Hoisted for the same reason as every other mutation flow here: a failed review submission's
  // retry must reuse this same actionId, only rotating to a fresh one after success.
  let reviewActionId = crypto.randomUUID();

  let currentContainer: HTMLElement | null = null;

  function rerender(): void {
    if (currentContainer) render(currentContainer);
  }

  function ensureLoaded(): void {
    if (loadStarted) return;
    loadStarted = true;
    const requestedFor = loadedForBootstrap;
    Promise.all([api.getHistory(), api.getInsights()])
      .then(([historyResult, insightsResult]) => {
        if (loadedForBootstrap !== requestedFor) return;
        history = historyResult;
        insights = insightsResult;
        reviewDrafts = new Map(insightsResult.baselineReview.changes.map(change => [change.category, { expectedAmount: "", newAmount: "" }]));
        rerender();
      })
      .catch((error: unknown) => {
        if (loadedForBootstrap !== requestedFor) return;
        // Deliberately do NOT reset loadStarted here - see history-view.ts's matching comment.
        // render() calls ensureLoaded() on every render; resetting loadStarted in this catch would
        // make it fire a fresh load immediately on the rerender() below, and if the RPC keeps
        // failing that becomes an unbounded chain of promise continuations with no macrotask in
        // between - starving the event loop rather than surfacing a normal error. A failed load
        // instead shows an error with an explicit "Try again" control (see retryLoad()).
        loadError = describeApiError(error);
        rerender();
      });
  }

  function retryLoad(): void {
    loadStarted = false;
    loadError = null;
    rerender();
  }

  function reverseTransfer(transfer: TransferView): void {
    if (rowPending.has(transfer.actionId)) return;
    rowPending.add(transfer.actionId);
    rowErrors.delete(transfer.actionId);
    let actionId = reversalActionIds.get(transfer.actionId);
    if (!actionId) {
      actionId = crypto.randomUUID();
      reversalActionIds.set(transfer.actionId, actionId);
    }
    rerender();

    api
      .reverseTransfer({ actionId, transferId: transfer.actionId })
      .then(({ result, planningState }) => {
        sessionTransfers = sessionTransfers.map(t => (t.actionId === transfer.actionId ? { ...t, status: "REVERSED" } : t));
        sessionTransfers = [result, ...sessionTransfers];
        rowPending.delete(transfer.actionId);
        reversalActionIds.delete(transfer.actionId);
        store.setState({ bootstrap: planningState });
      })
      .catch((error: unknown) => {
        rowPending.delete(transfer.actionId);
        rowErrors.set(transfer.actionId, describeApiError(error));
        rerender();
      });
  }

  function applyReview(reason: string): void {
    if (!insights) return;
    reviewPending = true;
    reviewError = null;
    rerender();

    const changes = insights.baselineReview.changes.map(change => {
      const row = reviewDrafts.get(change.category) ?? { expectedAmount: "", newAmount: "" };
      return {
        category: change.category,
        expectedAmount: Number(row.expectedAmount) as never,
        newAmount: Number(row.newAmount) as never,
      };
    });

    api
      .applyBaselineReview({ actionId: reviewActionId, reason, changes })
      .then(({ result, planningState }) => {
        reviewPending = false;
        reviewResultNote = `Applied ${result.changes.length} baseline change(s) at ${formatLocalDate(result.appliedAt.slice(0, 10))}.`;
        reviewActionId = crypto.randomUUID();
        insights = null;
        loadStarted = false;
        store.setState({ bootstrap: planningState });
        rerender();
        ensureLoaded();
      })
      .catch((error: unknown) => {
        reviewPending = false;
        reviewError = describeApiError(error);
        rerender();
      });
  }

  function renderTransferRow(list: HTMLUListElement, transfer: TransferView, reversible: boolean): void {
    const item = document.createElement("li");
    const month = transfer.createdAt.slice(0, 7);
    const text = document.createElement("span");
    text.textContent =
      `${month}: ${formatIDR(transfer.amount)} from ${transfer.fromCategory} to ${transfer.toCategory}` +
      (transfer.reason ? ` (${transfer.reason})` : "") +
      (transfer.relatedPlanId ? ` - related plan ${transfer.relatedPlanId}` : "") +
      ` - ${transfer.status}`;
    item.appendChild(text);

    if (reversible && transfer.status === "ACTIVE") {
      const reverseButton = document.createElement("button");
      reverseButton.type = "button";
      reverseButton.className = "button-secondary";
      reverseButton.textContent = "Reverse";
      reverseButton.disabled = rowPending.has(transfer.actionId);
      const panel = document.createElement("div");
      reverseButton.addEventListener("click", () => {
        renderConfirmDialog(panel, {
          title: "Confirm reversal",
          message: `This returns ${formatIDR(transfer.amount)} from ${transfer.toCategory} back to ${transfer.fromCategory}.`,
          confirmLabel: "Confirm reversal",
          onConfirm: () => {
            closeConfirmDialog(panel);
            reverseTransfer(transfer);
          },
          onCancel: () => closeConfirmDialog(panel),
        });
      });
      item.append(reverseButton, panel);
    }

    const rowError = rowErrors.get(transfer.actionId);
    if (rowError) {
      const error = document.createElement("p");
      error.className = "error-text";
      error.textContent = rowError;
      item.appendChild(error);
    }

    list.appendChild(item);
  }

  function render(container: HTMLElement): void {
    currentContainer = container;
    const currentBootstrap = store.getState().bootstrap;
    if (currentBootstrap !== loadedForBootstrap) {
      loadedForBootstrap = currentBootstrap;
      history = null;
      insights = null;
      loadStarted = false;
      loadError = null;
    }
    ensureLoaded();
    container.replaceChildren();

    const createSection = document.createElement("section");
    const toggleButton = document.createElement("button");
    toggleButton.type = "button";
    toggleButton.className = "button-primary";
    toggleButton.textContent = showCreateForm ? "Close" : "Create a transfer";
    toggleButton.addEventListener("click", () => {
      showCreateForm = !showCreateForm;
      rerender();
    });
    createSection.appendChild(toggleButton);
    if (showCreateForm) {
      const formHost = document.createElement("div");
      createForm(formHost);
      createSection.appendChild(formHost);
    }
    container.appendChild(createSection);

    const activitySection = document.createElement("section");
    const activityHeading = document.createElement("h2");
    activityHeading.textContent = "Current month transfers";
    activitySection.appendChild(activityHeading);

    const authoritative = store.getState().bootstrap?.activeTransfers ?? [];
    const activeSession = [...authoritative, ...sessionTransfers.filter(t => !authoritative.some(saved => saved.actionId === t.actionId))]
      .filter(t => t.status === "ACTIVE");
    if (activeSession.length === 0) {
      const empty = document.createElement("p");
      empty.textContent = "No active transfers this month.";
      activitySection.appendChild(empty);
    } else {
      const list = document.createElement("ul");
      for (const transfer of activeSession) renderTransferRow(list, transfer, true);
      activitySection.appendChild(list);
    }
    container.appendChild(activitySection);

    if (loadError) {
      const error = document.createElement("p");
      error.className = "error-text";
      error.textContent = loadError;
      container.appendChild(error);

      const retryButton = document.createElement("button");
      retryButton.type = "button";
      retryButton.className = "button-secondary";
      retryButton.textContent = "Try again";
      retryButton.addEventListener("click", retryLoad);
      container.appendChild(retryButton);
    }

    if (history) {
      const reversedSection = document.createElement("section");
      const reversedHeading = document.createElement("h2");
      reversedHeading.textContent = "Reversed transfers";
      reversedSection.appendChild(reversedHeading);

      if (history.transfers.length === 0) {
        const empty = document.createElement("p");
        empty.textContent = "No reversed transfers.";
        reversedSection.appendChild(empty);
      } else {
        const list = document.createElement("ul");
        for (const transfer of history.transfers.filter(entry => entry.status === "REVERSED")) renderTransferRow(list, transfer, false);
        reversedSection.appendChild(list);
      }
      container.appendChild(reversedSection);
    }

    if (insights) {
      const patternsSection = document.createElement("section");
      const patternsHeading = document.createElement("h2");
      patternsHeading.textContent = "Recurring patterns";
      patternsSection.appendChild(patternsHeading);

      const recipientsHeading = document.createElement("h3");
      recipientsHeading.textContent = "Repeat recipients";
      patternsSection.appendChild(recipientsHeading);
      const recipientsList = document.createElement("ul");
      if (insights.transferPatterns.recurringRecipients.length === 0) {
        const empty = document.createElement("li");
        empty.textContent = "No recurring recipients in the last 6 closed months.";
        recipientsList.appendChild(empty);
      } else {
        for (const pattern of insights.transferPatterns.recurringRecipients) recipientsList.appendChild(patternCard(pattern));
      }
      patternsSection.appendChild(recipientsList);

      const donorsHeading = document.createElement("h3");
      donorsHeading.textContent = "Repeat donors";
      patternsSection.appendChild(donorsHeading);
      const donorsList = document.createElement("ul");
      if (insights.transferPatterns.recurringDonors.length === 0) {
        const empty = document.createElement("li");
        empty.textContent = "No recurring donors in the last 6 closed months.";
        donorsList.appendChild(empty);
      } else {
        for (const pattern of insights.transferPatterns.recurringDonors) donorsList.appendChild(patternCard(pattern));
      }
      patternsSection.appendChild(donorsList);

      const reviewHeading = document.createElement("h3");
      reviewHeading.textContent = "Future-budget suggestion (review only)";
      patternsSection.appendChild(reviewHeading);

      if (reviewResultNote) {
        const note = document.createElement("p");
        note.textContent = reviewResultNote;
        patternsSection.appendChild(note);
      }

      if (insights.baselineReview.changes.length === 0) {
        const empty = document.createElement("p");
        empty.textContent = "No suggested baseline change this review - insufficient donor evidence.";
        patternsSection.appendChild(empty);
      } else {
        const reviewForm = document.createElement("div");
        reviewForm.className = "review-form";

        for (const change of insights.baselineReview.changes) {
          const row = document.createElement("div");
          row.className = "review-row";

          const summary = document.createElement("p");
          summary.textContent =
            `${change.category}: suggest ${change.direction === "INCREASE" ? "increase" : "decrease"} of ` +
            `${formatIDR(change.amount)} (seen ${change.frequency}/6 months, average ${formatIDR(change.averageMonthlyNet)}/month).`;
          row.appendChild(summary);

          const draft = reviewDrafts.get(change.category) ?? { expectedAmount: "", newAmount: "" };

          const expectedField = document.createElement("div");
          expectedField.className = "field";
          const expectedLabel = document.createElement("label");
          const expectedId = `review-expected-${change.category}`;
          expectedLabel.htmlFor = expectedId;
          expectedLabel.textContent = `${change.category} current baseline amount`;
          const expectedInput = document.createElement("input");
          expectedInput.id = expectedId;
          expectedInput.type = "number";
          expectedInput.value = draft.expectedAmount;
          expectedInput.addEventListener("input", () => {
            const current = reviewDrafts.get(change.category) ?? { expectedAmount: "", newAmount: "" };
            const expectedAmount = expectedInput.value;
            const parsedExpected = Number(expectedAmount);
            const suggestedNew =
              Number.isFinite(parsedExpected) && expectedAmount !== ""
                ? String(change.direction === "INCREASE" ? parsedExpected + change.amount : parsedExpected - change.amount)
                : current.newAmount;
            reviewDrafts.set(change.category, { expectedAmount, newAmount: current.newAmount || suggestedNew });
          });
          expectedField.append(expectedLabel, expectedInput);
          row.appendChild(expectedField);

          const newField = document.createElement("div");
          newField.className = "field";
          const newLabel = document.createElement("label");
          const newId = `review-new-${change.category}`;
          newLabel.htmlFor = newId;
          newLabel.textContent = `${change.category} new baseline amount`;
          const newInput = document.createElement("input");
          newInput.id = newId;
          newInput.type = "number";
          newInput.value = draft.newAmount;
          newInput.addEventListener("input", () => {
            const current = reviewDrafts.get(change.category) ?? { expectedAmount: "", newAmount: "" };
            reviewDrafts.set(change.category, { ...current, newAmount: newInput.value });
          });
          newField.append(newLabel, newInput);
          row.appendChild(newField);

          reviewForm.appendChild(row);
        }
        patternsSection.appendChild(reviewForm);

        const reviewPanel = document.createElement("div");
        reviewPanel.className = "confirm-panel-host";

        const reviewButton = document.createElement("button");
        reviewButton.type = "button";
        reviewButton.className = "button-secondary button-caution";
        reviewButton.textContent = "Review and apply";
        reviewButton.disabled = reviewPending;
        reviewButton.addEventListener("click", () => {
          renderConfirmDialog(reviewPanel, {
            title: "Confirm baseline change",
            message: "This updates future baseline budgets. It never happens automatically - only this explicit confirmation applies it.",
            confirmLabel: "Confirm baseline change",
            reasonLabel: "Reason",
            onConfirm: reason => {
              closeConfirmDialog(reviewPanel);
              applyReview(reason);
            },
            onCancel: () => closeConfirmDialog(reviewPanel),
          });
        });
        patternsSection.appendChild(reviewButton);
        patternsSection.appendChild(reviewPanel);

        if (reviewError) {
          const error = document.createElement("p");
          error.className = "error-text";
          error.textContent = reviewError;
          patternsSection.appendChild(error);
        }
      }

      container.appendChild(patternsSection);
    }
  }

  return (container, _state) => {
    render(container);
  };
}
