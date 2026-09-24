import { formatIDR } from "../format";
import { createTransferForm } from "./transfers-view";
import { PROTECTED_SAVINGS_CATEGORY } from "../../domain/transfers";
import type { Store } from "../state";
import type { ApiClient } from "../api";
import type { ViewRenderer } from "../render";

/**
 * The Budgets tab: category health with remaining-amount bars and a direct "Transfer budget"
 * action per category (spec section 11).
 *
 * Placement note: spec section 11's "Home / Plan" paragraph describes category health as appearing
 * "immediately below active plans, one short scroll away" - read literally that puts it on the Plan
 * tab. This task instead gives category health its own dedicated Budgets tab (as the brief's
 * per-file test-coverage mapping assigns "remaining-amount bars, direct Transfer budget action" to
 * budgets-view.test.ts, and a bottom-nav tab named "Budgets" needs a reason to exist). Read this as
 * describing the pre-tab-split mockup's single continuous scroll rather than a requirement that
 * conflicts with this task's four-tab architecture; plan-view.ts's first viewport still covers every
 * item the spec explicitly lists for it (Check a purchase, protected savings, funded amount,
 * safe-to-plan amount, days remaining, active reservations).
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
    container.replaceChildren();

    const bootstrap = store.getState().bootstrap;
    if (!bootstrap) return;

    const list = document.createElement("ul");
    list.className = "category-list";

    for (const category of bootstrap.categories.filter(c => c.category !== PROTECTED_SAVINGS_CATEGORY)) {
      const item = document.createElement("li");
      item.className = "card";

      const name = document.createElement("p");
      name.className = "category-name";
      name.textContent = category.category;
      item.appendChild(name);

      const remaining = document.createElement("p");
      remaining.textContent =
        category.availableBudget >= 0
          ? `${formatIDR(category.availableBudget)} remaining of ${formatIDR(category.adjustedBudget)}`
          : `${formatIDR(-category.availableBudget)} over the ${formatIDR(category.adjustedBudget)} budget`;
      if (category.availableBudget < 0) remaining.className = "error-text";
      item.appendChild(remaining);

      const consumedRatio =
        category.adjustedBudget > 0
          ? Math.min(1, Math.max(0, (category.adjustedBudget - category.availableBudget) / category.adjustedBudget))
          : 0;
      const percent = Math.round(consumedRatio * 100);

      const bar = document.createElement("div");
      bar.className = "bar";
      bar.setAttribute("role", "progressbar");
      bar.setAttribute("aria-label", `${category.category} budget consumed`);
      bar.setAttribute("aria-valuenow", String(percent));
      bar.setAttribute("aria-valuemin", "0");
      bar.setAttribute("aria-valuemax", "100");

      const fill = document.createElement("div");
      fill.className = category.availableBudget < 0 ? "bar-fill bar-fill-danger" : "bar-fill";
      fill.style.width = `${percent}%`;
      bar.appendChild(fill);
      item.appendChild(bar);

      const transferButton = document.createElement("button");
      transferButton.type = "button";
      transferButton.className = "button-secondary";
      transferButton.textContent = "Transfer budget";
      transferButton.addEventListener("click", () => toggleTransfer(category.category));
      item.appendChild(transferButton);

      if (openTransferFor === category.category && transferForm) {
        const host = document.createElement("div");
        transferForm(host);
        item.appendChild(host);
      }

      list.appendChild(item);
    }

    container.appendChild(list);
  }

  return (container, _state) => {
    render(container);
  };
}
