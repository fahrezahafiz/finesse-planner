import { createTransferForm } from "./transfers-view";
import { renderCategoryHealth } from "./category-health";
import type { Store } from "../state";
import type { ApiClient } from "../api";
import type { ViewRenderer } from "../render";

/**
 * The Budgets tab: category health with remaining-amount bars and a direct "Transfer budget"
 * action per category (spec section 11), rendered via category-health.ts's shared renderer.
 *
 * plan-view.ts also renders category health, immediately below its active-reservations section -
 * spec section 11 places category health "immediately below active plans, one short scroll away" in
 * the same section that defines the four-tab nav (Plan/Budgets/Transfers/History), so both tabs show
 * it: this tab as its own dedicated, fuller view of the same data; plan-view.ts so the Plan tab's
 * "one short scroll away" placement holds without navigating to a different tab.
 *
 * The "Transfer budget" action embeds transfers-view.ts's exported `createTransferForm` directly in
 * this category's row (no navigation away) rather than duplicating a second transfer-creation UI -
 * see transfers-view.ts's docstring for why that form lives there.
 */
export function createBudgetsRenderer(store: Store, api: ApiClient): ViewRenderer {
  let openTransferFor: string | null = null;
  let transferForm: ((container: HTMLElement) => void) | null = null;
  let currentContainer: HTMLElement | null = null;

  function rerender(): void {
    if (currentContainer) render(currentContainer);
  }

  function toggleTransfer(category: string): void {
    if (openTransferFor === category) {
      openTransferFor = null;
      transferForm = null;
    } else {
      openTransferFor = category;
      transferForm = createTransferForm(store, api, {
        initialFromCategory: category,
        onDone: () => {
          openTransferFor = null;
          transferForm = null;
          rerender();
        },
      });
    }
    rerender();
  }

  function render(container: HTMLElement): void {
    currentContainer = container;

    const bootstrap = store.getState().bootstrap;
    if (!bootstrap) {
      container.replaceChildren();
      return;
    }

    renderCategoryHealth(container, bootstrap.categories, {
      openTransferFor,
      transferForm,
      onToggleTransfer: toggleTransfer,
    });
  }

  return (container, _state) => {
    render(container);
  };
}
