import { createApi, createGoogleScriptRunner } from "./api";
import type { ApiClient, ApiError, ScriptRunner } from "./api";
import { createStore } from "./state";
import type { Store } from "./state";
import { mountShell, registerView } from "./render";
import { createPlanRenderer } from "./views/plan-view";
import { createBudgetsRenderer } from "./views/budgets-view";
import { createTransfersRenderer } from "./views/transfers-view";
import { createHistoryRenderer } from "./views/history-view";

function normalizeError(error: unknown): ApiError {
  if (error && typeof error === "object" && "code" in error && "message" in error) {
    return error as ApiError;
  }
  return { code: "INTERNAL_ERROR", message: "Something went wrong. Please try again." };
}

/**
 * Shared wiring surface for view modules. `render.ts`'s `registerView` only ever hands a
 * registered `ViewRenderer` a read-only `container`/`state` pair - it deliberately doesn't carry a
 * write-back channel, because the *view module* is expected to close over one instead. This is
 * that channel: Task 13's Plan/Budgets/Transfers/History modules call `createApp()` to get the
 * `store`/`api` pair.
 *
 * `createApp()` is memoized at module scope: the first call builds the `store`/`api` pair and
 * caches it; every later call - including this file's own bootstrap call below, and any call a
 * Task 13 view module makes with `import { createApp } from "./client"` - returns that exact same
 * cached pair, ignoring its `runner` argument. This is what guarantees a Task 13 view gets the
 * *same* `store` the shell mounted with `store.subscribe(render)` in render.ts, rather than a
 * second, disconnected `Store` whose `setState` calls no one is listening to. There is no second
 * construction path to accidentally take.
 *
 * `runner` defaults to the real `google.script.run` bridge on the first call; tests pass a fake
 * `ScriptRunner` so this never touches the Apps Script runtime. Tests that need a fresh pair (e.g.
 * to exercise a different runner) must call `resetApp()` first.
 */
let cachedApp: { store: Store; api: ApiClient } | null = null;

export function createApp(runner: ScriptRunner = createGoogleScriptRunner()): { store: Store; api: ApiClient } {
  if (!cachedApp) {
    const store = createStore();
    const api = createApi(runner);
    cachedApp = { store, api };

    // Task 13's real view renderers, wired here (rather than left to each caller) so every
    // consumer of createApp() - the bootstrap block below included - sees the full app, not just
    // the shell. Each is a closure over this exact store/api pair (see render.ts's docstring for
    // why that matters).
    registerView("plan", createPlanRenderer(store, api));
    registerView("budgets", createBudgetsRenderer(store, api));
    registerView("transfers", createTransfersRenderer(store, api));
    registerView("history", createHistoryRenderer(store, api));
  }
  return cachedApp;
}

/**
 * Test-only: clears the memoized `store`/`api` pair so one test's `createApp()` call can't leak
 * its state or runner into another. Mirrors render.ts's `resetViewRegistry`.
 */
export function resetApp(): void {
  cachedApp = null;
}

const appRoot = document.querySelector<HTMLElement>("#app");

if (appRoot) {
  const { store, api } = createApp();
  mountShell(appRoot, store);

  api
    .getBootstrap()
    .then(bootstrap => store.setState({ status: "ready", bootstrap, error: null }))
    .catch((error: unknown) => store.setState({ status: "error", error: normalizeError(error) }));
}
