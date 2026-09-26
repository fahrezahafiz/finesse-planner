import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/dom";
import { createApp, resetApp } from "../../src/client/client";
import { mountShell, registerView, resetViewRegistry } from "../../src/client/render";
import type { ViewRenderer } from "../../src/client/render";
import type { Store } from "../../src/client/state";
import type { ApiClient, ScriptRunner } from "../../src/client/api";
import type { PlanningStateView } from "../../src/server/view-models";

/**
 * Proves the extension point Important #1 asked for: a registered ViewRenderer only ever receives
 * a read-only (container, state) pair (render.ts:5), so a Task-13-shaped view - one that must call
 * a mutation, write the result back to the store, and navigate afterwards - has to reach
 * `store`/`api` some other way. `createApp()` (client.ts) is that way: it hands back the exact
 * `store`/`api` pair the shell itself uses, so a view module builds its renderer as a closure over
 * them before ever calling `registerView`.
 */

function bootstrapFixture(overrides: Partial<PlanningStateView> = {}): PlanningStateView {
  return {
    month: "2026-09",
    health: "HEALTHY",
    planningDate: "2026-09-24",
    daysRemaining: 6,
    protectedSavings: 500000,
    fundedAmount: 3000000,
    safeToPlanAmount: 750000,
    unallocatedHeadroom: 250000,
    categories: [],
    accounts: [],
    activeReservations: [],
    ...overrides,
  };
}

function root(): HTMLElement {
  document.body.innerHTML = "";
  const container = document.createElement("div");
  container.id = "app";
  document.body.appendChild(container);
  return container;
}

/**
 * Stand-in for a real Task 13 view module: built as `createStubPlanRenderer(store, api)`, exactly
 * the `createPlanRenderer(store, api): ViewRenderer` shape the reviewer asked this task to prove
 * out. On click it calls a mutation-shaped api method, then writes the refreshed planning state
 * back to the store and navigates to another view - the three things a real view needs and a
 * read-only `state` snapshot alone cannot provide.
 */
function createStubPlanRenderer(store: Store, api: ApiClient): ViewRenderer {
  return container => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Reserve";
    button.addEventListener("click", () => {
      void api
        .reservePurchase({
          actionId: "action-1",
          item: "Coffee",
          amount: 45000,
          category: "Dining",
          plannedDate: "2026-09-25",
          paymentAccount: "Cash",
        })
        .then(({ planningState }) => {
          store.setState({ status: "ready", bootstrap: planningState, error: null, view: "history" });
        });
    });
    container.appendChild(button);
  };
}

beforeEach(() => {
  resetViewRegistry();
  resetApp();
});

describe("view write-back channel (store/api reachable from a registered view)", () => {
  it("lets a view built as a store/api closure call a mutation, write the result back, and navigate", async () => {
    const reservePurchaseRpc = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        actionId: "action-1",
        result: {
          actionId: "action-1",
          item: "Coffee",
          category: "Dining",
          paymentAccount: "Cash",
          amount: 45000,
          plannedDate: "2026-09-25",
          status: "RESERVED",
          verdict: "OK",
          failedGuardrails: [],
          overrideReason: "",
          createdAt: "2026-09-24T00:00:00+07:00",
          completedAt: null,
        },
        planningState: bootstrapFixture({ safeToPlanAmount: 705000 }),
      },
    });
    const runner: ScriptRunner = {
      run: (functionName: string, ...args: unknown[]) => {
        if (functionName === "reservePurchaseRpc") return reservePurchaseRpc(...args);
        throw new Error(`unexpected RPC call: ${functionName}`);
      },
    };

    const { store, api } = createApp(runner);
    registerView("plan", createStubPlanRenderer(store, api));

    mountShell(root(), store);
    store.setState({ status: "ready", bootstrap: bootstrapFixture(), error: null });

    fireEvent.click(screen.getByRole("button", { name: "Reserve" }));

    await waitFor(() => expect(store.getState().view).toBe("history"));

    expect(reservePurchaseRpc).toHaveBeenCalledWith(expect.objectContaining({ actionId: "action-1" }));
    expect(store.getState().bootstrap?.safeToPlanAmount).toBe(705000);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("History");
  });
});

describe("createApp", () => {
  it("returns a store seeded with the default client state and an api built on the given runner", () => {
    const run = vi.fn().mockResolvedValue({ ok: true, data: bootstrapFixture() });
    const { store, api } = createApp({ run });

    expect(store.getState().status).toBe("loading");
    expect(typeof api.getBootstrap).toBe("function");
  });

  /**
   * Regression test for the disconnected-store defect the reviewer flagged: a Task 13 view module
   * lives in its own file and gets `store`/`api` by calling `createApp()` itself, not by receiving
   * a shared reference from client.ts's bootstrap block. If `createApp()` built a fresh `Store` on
   * every call, that second call's store would have an empty `listeners` set - `mountShell`'s
   * `store.subscribe(render)` would only ever be watching the *first* instance - so the view's
   * `store.setState(...)` calls would silently fail to re-render or navigate the shell. Calling
   * `createApp()` twice (with different runners, to prove the argument is ignored after the first
   * call) and asserting both calls return the same `store`/`api` object is what catches that.
   */
  it("returns the exact same store/api pair on a second call, so a separate view module can't get a disconnected store", () => {
    const first = createApp({ run: vi.fn().mockResolvedValue({ ok: true, data: bootstrapFixture() }) });
    const second = createApp({ run: vi.fn().mockResolvedValue({ ok: true, data: bootstrapFixture() }) });

    expect(second.store).toBe(first.store);
    expect(second.api).toBe(first.api);
  });
});
