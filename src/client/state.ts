import type { PlanningStateView } from "../server/view-models";
import type { ApiError } from "./api";

/** The four navigation destinations. Task 13 registers a real renderer for each with render.ts's registerView. */
export type ViewName = "plan" | "budgets" | "transfers" | "history";

export type LoadStatus = "loading" | "ready" | "error";

/**
 * Centralized client state: which view is active, the bootstrap PlanningStateView (the "first
 * viewport" from Task 11's getBootstrap), and whether that bootstrap load is in flight, settled,
 * or failed. Task 13's views read this same shape rather than each re-fetching or duplicating it.
 */
export interface ClientState {
  readonly view: ViewName;
  readonly status: LoadStatus;
  readonly bootstrap: PlanningStateView | null;
  readonly error: ApiError | null;
}

type Listener = (state: ClientState) => void;

export interface Store {
  getState(): ClientState;
  setState(patch: Partial<ClientState>): void;
  subscribe(listener: Listener): () => void;
}

const DEFAULT_STATE: ClientState = {
  view: "plan",
  status: "loading",
  bootstrap: null,
  error: null,
};

/**
 * A minimal mutable store with a plain pub-sub subscription list - not a framework, just enough
 * for render.ts to re-render whenever setState is called. `initial` lets tests and client.ts seed
 * a starting state without going through a real bootstrap call.
 */
export function createStore(initial: Partial<ClientState> = {}): Store {
  let state: ClientState = { ...DEFAULT_STATE, ...initial };
  const listeners = new Set<Listener>();

  function getState(): ClientState {
    return state;
  }

  function setState(patch: Partial<ClientState>): void {
    state = { ...state, ...patch };
    for (const listener of listeners) listener(state);
  }

  function subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return { getState, setState, subscribe };
}
