import { formatIDR } from "../format";
import { PROTECTED_SAVINGS_CATEGORY } from "../../domain/transfers";
import type { CategoryBudgetView } from "../../server/view-models";

/**
 * Shared category-health renderer (remaining amounts, consumption bars, and a direct "Transfer
 * budget" action per category - spec section 11). Spec section 11 places this "immediately below
 * active plans, one short scroll away" on the Plan tab, in the same section that defines the
 * four-tab nav (Plan/Budgets/Transfers/History) - so plan-view.ts renders it too, immediately below
 * active reservations. budgets-view.ts keeps rendering it as well, as a fuller dedicated view of the
 * same data. Both callers own their own open/close state for the inline transfer form (each tab's
 * "Transfer budget" button toggles independently) and pass it in via `options`.
 */
export interface CategoryHealthOptions {
  readonly openTransferFor: string | null;
  readonly transferForm: ((container: HTMLElement) => void) | null;
  readonly onToggleTransfer: (category: string) => void;
}

export function renderCategoryHealth(
  container: HTMLElement,
  categories: readonly CategoryBudgetView[],
  options: CategoryHealthOptions,
): void {
  container.replaceChildren();

  const list = document.createElement("ul");
  list.className = "category-list";

  for (const category of categories.filter(c => c.category !== PROTECTED_SAVINGS_CATEGORY)) {
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
    transferButton.addEventListener("click", () => options.onToggleTransfer(category.category));
    item.appendChild(transferButton);

    if (options.openTransferFor === category.category && options.transferForm) {
      const host = document.createElement("div");
      options.transferForm(host);
      item.appendChild(host);
    }

    list.appendChild(item);
  }

  container.appendChild(list);
}
