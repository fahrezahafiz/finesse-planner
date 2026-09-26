import { formatIDR, formatLocalDate } from "../format";
import type { Store } from "../state";
import type { ApiClient, ApiError } from "../api";
import type { ViewRenderer } from "../render";
import type { HistoryView, PlanningStateView } from "../../server/view-models";

/**
 * The History tab: the full past-tense record via api.getHistory() alone - completed, cancelled,
 * and expired plans; reversed transfers; received and cancelled income. Current-month transfer
 * activity and forward-looking insights live on the Transfers tab instead (see
 * transfers-view.ts's docstring for that resolved decision).
 */
function describeApiError(error: unknown): string {
  const apiError = error as ApiError;
  return apiError?.message ?? "Something went wrong. Please try again.";
}

export function createHistoryRenderer(store: Store, api: ApiClient): ViewRenderer {
  let history: HistoryView | null = null;
  let loadStarted = false;
  let loadError: string | null = null;
  let currentContainer: HTMLElement | null = null;
  let loadedForBootstrap: PlanningStateView | null = null;

  function rerender(): void {
    if (currentContainer) render(currentContainer);
  }

  function ensureLoaded(): void {
    if (loadStarted) return;
    loadStarted = true;
    const requestedFor = loadedForBootstrap;
    api
      .getHistory()
      .then(result => {
        if (loadedForBootstrap !== requestedFor) return;
        history = result;
        rerender();
      })
      .catch((error: unknown) => {
        if (loadedForBootstrap !== requestedFor) return;
        // Deliberately do NOT reset loadStarted here. render() calls ensureLoaded() on every
        // render, and this catch runs inside a rerender() it triggers - resetting loadStarted
        // would make ensureLoaded() fire a fresh getHistory() call immediately, which (if the RPC
        // keeps failing) recreates this same catch forever: an unbounded chain of promise
        // continuations with no macrotask in between, which starves the JS event loop rather than
        // just failing one test/request. Leaving loadStarted true means a failed load surfaces an
        // error with an explicit "Try again" control instead (see retryLoad()).
        loadError = describeApiError(error);
        rerender();
      });
  }

  function retryLoad(): void {
    loadStarted = false;
    loadError = null;
    rerender();
  }

  function render(container: HTMLElement): void {
    currentContainer = container;
    const currentBootstrap = store.getState().bootstrap;
    if (currentBootstrap !== loadedForBootstrap) {
      loadedForBootstrap = currentBootstrap;
      history = null;
      loadStarted = false;
      loadError = null;
    }
    ensureLoaded();
    container.replaceChildren();

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
      return;
    }

    if (!history) {
      const loading = document.createElement("p");
      loading.textContent = "Loading history…";
      container.appendChild(loading);
      return;
    }

    const plansSection = document.createElement("section");
    const plansHeading = document.createElement("h2");
    plansHeading.textContent = "Past purchases";
    plansSection.appendChild(plansHeading);

    if (history.plans.length === 0) {
      const empty = document.createElement("p");
      empty.textContent = "No completed, cancelled, or expired plans yet.";
      plansSection.appendChild(empty);
    } else {
      const list = document.createElement("ul");
      for (const plan of history.plans) {
        const item = document.createElement("li");
        item.textContent =
          `${plan.item}: ${formatIDR(plan.amount)} (${plan.category}, ${plan.paymentAccount}) - ${plan.status}` +
          (plan.completedAt ? `, completed ${formatLocalDate(plan.completedAt.slice(0, 10))}` : ``) +
          (plan.overrideReason ? ` - override reason: ${plan.overrideReason}` : "");
        list.appendChild(item);
      }
      plansSection.appendChild(list);
    }
    container.appendChild(plansSection);

    const transfersSection = document.createElement("section");
    const transfersHeading = document.createElement("h2");
    transfersHeading.textContent = "Transfer history";
    transfersSection.appendChild(transfersHeading);

    if (history.transfers.length === 0) {
      const empty = document.createElement("p");
      empty.textContent = "No transfers yet.";
      transfersSection.appendChild(empty);
    } else {
      const list = document.createElement("ul");
      for (const transfer of history.transfers) {
        const item = document.createElement("li");
        item.textContent =
          `${formatIDR(transfer.amount)} from ${transfer.fromCategory} to ${transfer.toCategory}` +
          (transfer.reason ? ` (${transfer.reason})` : "") +
          ` - ${transfer.status}, ${transfer.month}, by ${transfer.createdBy}`;
        list.appendChild(item);
      }
      transfersSection.appendChild(list);
    }
    container.appendChild(transfersSection);

    const incomeSection = document.createElement("section");
    const incomeHeading = document.createElement("h2");
    incomeHeading.textContent = "Income";
    incomeSection.appendChild(incomeHeading);

    if (history.income.length === 0) {
      const empty = document.createElement("p");
      empty.textContent = "No received or cancelled income yet.";
      incomeSection.appendChild(empty);
    } else {
      const list = document.createElement("ul");
      for (const income of history.income) {
        const item = document.createElement("li");
        item.textContent =
          `${formatIDR(income.amount)} from ${income.source} to ${income.destinationAccount} on ${formatLocalDate(income.expectedDate)} - ${income.status}`;
        list.appendChild(item);
      }
      incomeSection.appendChild(list);
    }
    container.appendChild(incomeSection);
  }

  return (container, _state) => {
    render(container);
  };
}
