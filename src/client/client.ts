import { createApi, createGoogleScriptRunner } from "./api";
import type { ApiClient, ApiError, ScriptRunner } from "./api";
import { createStore } from "./state";
import type { Store } from "./state";
import { mountShell } from "./render";

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
 * that channel: Task 13's Plan/Budgets/Transfers/History modules call `createApp()` (or share one
 * instance, e.g. by importing `{ store, api }` from a small wiring module built on top of this) to
 * get the same `store` mounted by the shell and an `api` for calling secured RPC endpoints, then
 * build a closure like `createPlanRenderer(store, api): ViewRenderer` - which can call
 * `api.reservePurchase(...)`, await the result, call `store.setState(...)` to update the UI, and
 * even navigate by setting `store.setState({ view: "history" })` - and pass that to
 * `registerView("plan", createPlanRenderer(store, api))`.
 *
 * `runner` defaults to the real `google.script.run` bridge; tests pass a fake `ScriptRunner` so
 * this never touches the Apps Script runtime.
 */
export function createApp(runner: ScriptRunner = createGoogleScriptRunner()): { store: Store; api: ApiClient } {
  const store = createStore();
  const api = createApi(runner);
  return { store, api };
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
