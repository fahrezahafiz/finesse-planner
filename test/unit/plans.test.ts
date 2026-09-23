import { describe, expect, it } from "vitest";
import { transitionPlan, parseProposal } from "../../src/domain/plans";
import { withDocumentLock } from "../../src/server/lock";
import { jakartaClock } from "../../src/domain/time";
import { validProposal } from "../helpers/domain-fixtures";

const clock = jakartaClock(new Date("2026-09-23T00:00:00Z"));
describe("plan lifecycle", () => {
  it.each(["RESERVED", "OVERRIDDEN"] as const)("allows active %s plans to reach each terminal state", status => {
    for (const next of ["COMPLETED", "CANCELLED", "EXPIRED"] as const) expect(transitionPlan(status, next)).toBe(next);
  });
  it.each(["COMPLETED", "CANCELLED", "EXPIRED"] as const)("does not revive terminal %s history", status => {
    expect(() => transitionPlan(status, "RESERVED")).toThrow("INVALID_INPUT");
    expect(() => transitionPlan(status, "CANCELLED")).toThrow("INVALID_INPUT");
  });
  it.each([0, -1, 1.5, "700000", Number.MAX_SAFE_INTEGER + 1])("rejects unsafe or nonpositive amount %s", amount => {
    expect(() => parseProposal({ ...validProposal(), amount }, clock)).toThrow("INVALID_AMOUNT");
  });
  it.each(["2026-09-22", "2026-10-01", "2026-02-30"])("rejects out-of-window or invalid planned date %s", plannedDate => {
    expect(() => parseProposal({ ...validProposal(), plannedDate }, clock)).toThrow("INVALID_DATE");
  });
  it.each([{ actionId: " " }, { item: " " }, { category: "" }, { paymentAccount: " " }, { actionId: "=IMPORTXML(x)" }])("rejects missing or unsafe identities %j", fields => {
    expect(() => parseProposal({ ...validProposal(), ...fields }, clock)).toThrow("INVALID_INPUT");
  });
  it("fails closed when no document lock is available", () => {
    expect(() => withDocumentLock(null, () => "written")).toThrow("LOCK_TIMEOUT");
  });
  it("never enters a mutation after lock timeout", () => {
    let writes = 0;
    expect(() => withDocumentLock({ tryLock: timeout => { expect(timeout).toBe(30000); return false; }, releaseLock: () => { throw new Error("unowned lock"); } }, () => ++writes)).toThrow("LOCK_TIMEOUT");
    expect(writes).toBe(0);
  });
  it("releases an acquired lock when a mutation throws", () => {
    let held = false;
    const lock = { tryLock: () => held = true, releaseLock: () => { held = false; } };
    expect(() => withDocumentLock(lock, () => { throw new Error("write failed"); })).toThrow("write failed");
    expect(held).toBe(false);
  });
});
