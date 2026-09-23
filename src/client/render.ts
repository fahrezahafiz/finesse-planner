import type { ClientState, Store, ViewName } from "./state";
import { formatIDR, formatLocalDate } from "./format";

/**
 * A view renderer fills `container` (the view's content area, below its h1) from the current
 * state. `state` is a read-only snapshot - a renderer that needs to call a mutation (e.g.
 * `api.reservePurchase(...)`), update the store afterwards so the shell re-renders, or navigate to
 * another view is expected to close over `store`/`api` rather than receive them here. See
 * `createApp()` in client.ts for how a view module gets that `store`/`api` pair.
 */
export type ViewRenderer = (container: HTMLElement, state: ClientState) => void;

const VIEW_ORDER: readonly ViewName[] = ["plan", "budgets", "transfers", "history"];

const VIEW_LABELS: Record<ViewName, string> = {
  plan: "Plan",
  budgets: "Budgets",
  transfers: "Transfers",
  history: "History",
};

/**
 * Extension point for later client tasks: Task 13 calls registerView("plan", renderPlanView) (and
 * the same for budgets/transfers/history) before or after mountShell runs. Whatever renderer is
 * registered for a view replaces this file's placeholder for it on the next render - mountShell
 * never needs to know Task 13's renderers exist ahead of time.
 *
 * A registered renderer is a closure built by the view module itself, e.g.
 * `registerView("plan", createPlanRenderer(store, api))`, where `store`/`api` come from
 * client.ts's `createApp()`. See test/unit/client-app.test.ts for a worked example of a stub
 * renderer reaching an injected store/api this way.
 */
const viewRenderers = new Map<ViewName, ViewRenderer>();

export function registerView(view: ViewName, render: ViewRenderer): void {
  viewRenderers.set(view, render);
}

/** Test-only: clears registered renderers so one test's registerView call can't leak into another. */
export function resetViewRegistry(): void {
  viewRenderers.clear();
}

function appendSummaryRow(list: HTMLDListElement, label: string, value: string): void {
  const dt = document.createElement("dt");
  dt.textContent = label;
  const dd = document.createElement("dd");
  dd.textContent = value;
  list.append(dt, dd);
}

/**
 * The default placeholder shown for any view without a registered renderer. It's more than an
 * empty box: PlanningStateView is documented as the client's "first viewport", so this surfaces
 * that summary (safe-to-plan, protected savings, days remaining, active reservations) on every
 * view until Task 13 replaces each view's placeholder with its real screen.
 */
function defaultViewBody(container: HTMLElement, state: ClientState): void {
  const bootstrap = state.bootstrap;
  if (!bootstrap) return;

  const summary = document.createElement("dl");
  summary.className = "summary";
  appendSummaryRow(summary, "Safe to plan", formatIDR(bootstrap.safeToPlanAmount));
  appendSummaryRow(summary, "Protected savings", formatIDR(bootstrap.protectedSavings));
  appendSummaryRow(summary, "Days remaining", String(bootstrap.daysRemaining));
  appendSummaryRow(summary, "Planning date", formatLocalDate(bootstrap.planningDate));
  container.appendChild(summary);

  const reservations = document.createElement("section");
  const heading = document.createElement("h2");
  heading.textContent = "Active reservations";
  reservations.appendChild(heading);

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
  container.appendChild(reservations);

  const note = document.createElement("p");
  note.className = "muted";
  note.textContent = "The full view is coming soon.";
  container.appendChild(note);
}

export interface ShellHandle {
  readonly root: HTMLElement;
}

/**
 * Renders the app shell into `root` and subscribes to `store` so every setState re-renders it.
 * Builds: a skip link, one <main> landmark, one <h1> per active view, an aria-live status region
 * for loading/error announcements, and a bottom navigation with 4 buttons (aria-current="page" on
 * the active one). Moves focus to the new view's heading whenever the active view changes.
 */
export function mountShell(root: HTMLElement, store: Store): ShellHandle {
  root.innerHTML = "";

  const skipLink = document.createElement("a");
  skipLink.className = "skip-link";
  skipLink.href = "#main-content";
  skipLink.textContent = "Skip to content";

  const status = document.createElement("div");
  status.className = "status-region";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");

  const main = document.createElement("main");
  main.id = "main-content";
  main.tabIndex = -1;

  const nav = document.createElement("nav");
  nav.className = "bottom-nav";
  nav.setAttribute("aria-label", "Primary");

  const navButtons = new Map<ViewName, HTMLButtonElement>();
  for (const view of VIEW_ORDER) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = VIEW_LABELS[view];
    button.addEventListener("click", () => {
      if (store.getState().view !== view) store.setState({ view });
    });
    navButtons.set(view, button);
    nav.appendChild(button);
  }

  root.append(skipLink, status, main, nav);

  skipLink.addEventListener("click", () => {
    main.focus();
  });

  let previousView: ViewName | null = null;

  function render(): void {
    const state = store.getState();

    status.textContent =
      state.status === "loading"
        ? "Loading your plan…"
        : state.status === "error"
          ? (state.error?.message ?? "Something went wrong. Please try again.")
          : "";

    for (const [view, button] of navButtons) {
      if (view === state.view) {
        button.setAttribute("aria-current", "page");
      } else {
        button.removeAttribute("aria-current");
      }
    }

    main.innerHTML = "";
    const heading = document.createElement("h1");
    heading.textContent = VIEW_LABELS[state.view];
    heading.tabIndex = -1;
    main.appendChild(heading);

    const body = document.createElement("div");
    body.className = "view-body";
    main.appendChild(body);

    if (state.status === "loading") {
      const loading = document.createElement("p");
      loading.textContent = "Loading your plan…";
      body.appendChild(loading);
    } else if (state.status === "error") {
      const error = document.createElement("p");
      error.className = "error-text";
      error.textContent = state.error?.message ?? "Something went wrong. Please try again.";
      body.appendChild(error);
    } else {
      const renderer = viewRenderers.get(state.view) ?? defaultViewBody;
      renderer(body, state);
    }

    if (previousView !== null && previousView !== state.view) {
      heading.focus();
    }
    previousView = state.view;
  }

  store.subscribe(render);
  render();

  return { root };
}
