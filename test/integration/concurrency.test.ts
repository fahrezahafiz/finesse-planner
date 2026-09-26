import { afterEach, describe, expect, it, vi } from "vitest";
import { endpointFixture, planCommand, unwrap } from "../helpers/endpoint-fixture";

afterEach(() => vi.unstubAllGlobals());

/**
 * Covers the plan's "Review Focus" concurrency cases verbatim (docs/superpowers/plans/2026-09-23-
 * mindful-expense-planner.md, lines ~30-34), exercised through the secured RPC/endpoint surface:
 *
 *   - Two requests with different action IDs arrive for the same final category capacity; the
 *     second request must reread under lock and fail if both cannot fit.
 *   - Asia/Jakarta crosses midnight or month-end during a request; the server must use one captured
 *     clock value and expire past-month reservations consistently.
 */

describe("racing reservations for the last remaining category capacity", () => {
  it("fails the second of two distinct-actionId requests when only one fits, proving it rereads fresh state under lock rather than trusting its own pre-lock check", () => {
    const f = endpointFixture();
    const proposalA = planCommand({ actionId: "race-a", amount: 400000 });
    const proposalB = planCommand({ actionId: "race-b", amount: 400000 });

    // Both requests independently see the full 600000 Dining budget before either acquires the lock.
    expect(unwrap(f.endpoints.checkPurchaseRpc(proposalA)).decision.verdict).toBe("RECOMMENDED");
    expect(unwrap(f.endpoints.checkPurchaseRpc(proposalB)).decision.verdict).toBe("RECOMMENDED");

    // Request A reaches the lock first and commits, consuming 400000 of the 600000 budget.
    const first = unwrap(f.endpoints.reservePurchaseRpc(proposalA));
    expect(first.result.status).toBe("RESERVED");

    // Request B reaches the lock second. It must reread the ledger fresh under the lock rather than
    // reuse the RECOMMENDED verdict it computed before either request touched the lock.
    const second = f.endpoints.reservePurchaseRpc(proposalB);
    expect(second).toMatchObject({ ok: false, error: { code: "CATEGORY_BUDGET_EXCEEDED" } });
    expect(f.planRepository.list().map(plan => plan.actionId)).toEqual(["race-a"]);
  });

  it("returns LOCK_TIMEOUT and writes nothing when a second request genuinely overlaps the first while its lock is held", () => {
    const f = endpointFixture();
    f.onAcquire(() => {
      const overlapping = f.endpoints.reservePurchaseRpc(planCommand({ actionId: "race-b", amount: 100000 }));
      expect(overlapping).toMatchObject({ ok: false, error: { code: "LOCK_TIMEOUT" } });
    });

    const result = unwrap(f.endpoints.reservePurchaseRpc(planCommand({ actionId: "race-a", amount: 100000 })));
    expect(result.result.status).toBe("RESERVED");
    expect(f.planRepository.list().map(plan => plan.actionId)).toEqual(["race-a"]);
  });
});

describe("Asia/Jakarta month/midnight rollover during a request", () => {
  it("reads the wall clock exactly once per request, even though a second read would land in a new month", () => {
    const f = endpointFixture({ now: new Date("2026-09-30T16:59:59.000Z") }); // 2026-09-30T23:59:59 Jakarta
    let calls = 0;
    const wallClock = f.deps.now;
    const mutableDeps = f.deps as unknown as { now: () => Date };
    mutableDeps.now = () => { calls += 1; return wallClock(); };

    unwrap(f.endpoints.reservePurchaseRpc(planCommand({ amount: 100000, plannedDate: "2026-09-30" })));
    expect(calls).toBe(1);

    calls = 0;
    unwrap(f.endpoints.getBootstrap(undefined)); // internally expires stale plans, then reads the snapshot
    expect(calls).toBe(1);
  });

  it("does not expire a reservation planned for the current month at the last instant before Jakarta's month rollover", () => {
    const f = endpointFixture({ now: new Date("2026-09-30T16:59:59.000Z") }); // 2026-09-30T23:59:59 Jakarta
    unwrap(f.endpoints.reservePurchaseRpc(planCommand({ actionId: "plan-1", amount: 100000, plannedDate: "2026-09-30" })));

    const state = unwrap(f.endpoints.getBootstrap(undefined));
    expect(state.month).toBe("2026-09");
    expect(f.planRepository.list().map(plan => plan.status)).toEqual(["RESERVED"]);
    expect(state.activeReservations).toHaveLength(1);
  });

  it("expires the same reservation consistently once a new request's clock has rolled over the month", () => {
    const f = endpointFixture({ now: new Date("2026-09-30T16:59:59.000Z") }); // 2026-09-30T23:59:59 Jakarta
    unwrap(f.endpoints.reservePurchaseRpc(planCommand({ actionId: "plan-1", amount: 100000, plannedDate: "2026-09-30" })));

    // Real time passes past Jakarta midnight into October; the next request captures a fresh clock.
    f.advanceTo(new Date("2026-09-30T17:00:01.000Z")); // 2026-10-01T00:00:01 Jakarta
    f.sheets.get("backend")!.getRange("G2").setValue("2026-10-01");
    f.sheets.get("Catat - Pendapatan")!.getRange("B2").setValue(new Date("2026-10-01T00:00:00+07:00"));

    const state = unwrap(f.endpoints.getBootstrap(undefined));
    expect(state.month).toBe("2026-10");
    expect(f.planRepository.list().map(plan => plan.status)).toEqual(["EXPIRED"]);
    expect(state.activeReservations).toEqual([]);

    // The rollover is applied exactly once and is idempotent on a further request in the same month.
    const again = unwrap(f.endpoints.getBootstrap(undefined));
    expect(f.planRepository.list().map(plan => plan.status)).toEqual(["EXPIRED"]);
    expect(again.month).toBe("2026-10");
  });
});
