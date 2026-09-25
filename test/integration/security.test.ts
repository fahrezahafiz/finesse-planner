import { afterEach, describe, expect, it, vi } from "vitest";
import { endpointFixture, planCommand, transferCommand, incomeCommand, unwrap } from "../helpers/endpoint-fixture";

afterEach(() => vi.unstubAllGlobals());

/**
 * Covers spec section 13 ("Error handling"), section 12 ("Access and security"), and the plan's
 * "Review Focus" security/malformed-input cases, exercised through the secured RPC/endpoint surface:
 *
 *   - Currency or date inputs contain separators, decimals, invalid calendar dates, or values beyond
 *     safe integer range; the server must reject them rather than coerce them.
 *   - Workbook access is revoked, OAuth scope is missing, or a formula becomes an error after the UI
 *     loaded; the next server request must return no financial data and perform no write.
 *   - Expense append succeeds but plan finalization is interrupted; retry must find the transaction
 *     row by developer metadata and finalize without appending a duplicate.
 */

describe("malformed currency and date inputs are rejected, never coerced", () => {
  it("rejects an amount written with thousands separators", () => {
    const f = endpointFixture();
    const result = f.endpoints.reservePurchaseRpc(planCommand({ amount: "300,000" as never }));
    expect(result).toMatchObject({ ok: false, error: { code: "INVALID_AMOUNT" } });
    expect(f.planRepository.list()).toEqual([]);
  });

  it("rejects a decimal (non-integer) amount instead of rounding or truncating it", () => {
    const f = endpointFixture();
    const result = f.endpoints.reservePurchaseRpc(planCommand({ amount: 300000.5 }));
    expect(result).toMatchObject({ ok: false, error: { code: "INVALID_AMOUNT" } });
    expect(f.planRepository.list()).toEqual([]);
  });

  it("rejects an amount beyond the safe integer range", () => {
    const f = endpointFixture();
    const result = f.endpoints.reservePurchaseRpc(planCommand({ amount: Number.MAX_SAFE_INTEGER + 1 }));
    expect(result).toMatchObject({ ok: false, error: { code: "INVALID_AMOUNT" } });
    expect(f.planRepository.list()).toEqual([]);
  });

  it("rejects a negative amount", () => {
    const f = endpointFixture();
    const result = f.endpoints.reservePurchaseRpc(planCommand({ amount: -100000 }));
    expect(result).toMatchObject({ ok: false, error: { code: "INVALID_AMOUNT" } });
    expect(f.planRepository.list()).toEqual([]);
  });

  it("rejects an invalid calendar date (30 February) instead of normalizing it into March", () => {
    const f = endpointFixture();
    const result = f.endpoints.reservePurchaseRpc(planCommand({ plannedDate: "2026-02-30" }));
    expect(result).toMatchObject({ ok: false, error: { code: "INVALID_DATE" } });
    expect(f.planRepository.list()).toEqual([]);
  });

  it("rejects a date in a non-ISO, separator-laden format", () => {
    const f = endpointFixture();
    const result = f.endpoints.reservePurchaseRpc(planCommand({ plannedDate: "09/24/2026" }));
    expect(result).toMatchObject({ ok: false, error: { code: "INVALID_DATE" } });
    expect(f.planRepository.list()).toEqual([]);
  });

  it("rejects a malformed transfer amount before touching the transfer ledger", () => {
    const f = endpointFixture();
    const result = f.endpoints.createTransferRpc(transferCommand({ amount: "100.000,00" as never }));
    expect(result).toMatchObject({ ok: false, error: { code: "INVALID_AMOUNT" } });
    expect(f.transferRepository.list()).toEqual([]);
  });

  it("rejects a malformed expected-income amount before touching the income ledger", () => {
    const f = endpointFixture();
    const result = f.endpoints.createExpectedIncomeRpc(incomeCommand({ amount: 500000.99 }));
    expect(result).toMatchObject({ ok: false, error: { code: "INVALID_AMOUNT" } });
    expect(f.incomeRepository.list()).toEqual([]);
  });
});

describe("revoked access, missing OAuth scope, and formula errors after the UI loaded", () => {
  it("returns no financial data and performs no write on the next request once workbook access is revoked", () => {
    const f = endpointFixture();
    const bootstrap = unwrap(f.endpoints.getBootstrap(undefined));
    expect(bootstrap.health).toBe("HEALTHY");

    f.deps.spreadsheetApp = { openById: () => { throw new Error("Permission denied for book-id"); } };

    const next = f.endpoints.getBootstrap(undefined);
    expect(next).toEqual({ ok: false, error: { code: "ACCESS_DENIED", message: "Access to this planner is denied." } });

    const reservation = f.endpoints.reservePurchaseRpc(planCommand());
    expect(reservation).toMatchObject({ ok: false, error: { code: "ACCESS_DENIED" } });
    expect(f.planRepository.list()).toEqual([]);
    expect(JSON.stringify(next)).not.toMatch(/book-id|Permission/i);
  });

  it("returns no financial data and performs no write on the next request once a required OAuth scope is missing", () => {
    const f = endpointFixture();
    unwrap(f.endpoints.getBootstrap(undefined));

    f.deps.scriptApp = {
      getAuthorizationInfo: () => ({
        getAuthorizationStatus: () => "REQUIRED" as unknown as GoogleAppsScript.Script.AuthorizationStatus,
        getAuthorizationUrl: () => "https://script.google.com/macros/d/safe-script-id/usercallback",
      }),
    };

    const next = f.endpoints.reservePurchaseRpc(planCommand());
    expect(next).toMatchObject({ ok: false, error: { code: "AUTHORIZATION_REQUIRED" } });
    expect(f.planRepository.list()).toEqual([]);

    const bootstrap = f.endpoints.getBootstrap(undefined);
    expect(bootstrap).toMatchObject({ ok: false, error: { code: "AUTHORIZATION_REQUIRED" } });
  });

  it("returns no financial data and blocks writes on the next request once a workbook formula becomes an error", () => {
    const f = endpointFixture();
    unwrap(f.endpoints.getBootstrap(undefined)); // the UI loaded successfully first

    // The calibrated category-names formula in Ringkasan Perencanaan no longer matches what setup
    // wrote: this is what "a formula becomes an error" looks like from the reader's perspective.
    f.summary.getRange("A2").setFormula("=1/0");

    const check = unwrap(f.endpoints.checkPurchaseRpc(planCommand()));
    expect(check.decision.verdict).toBe("UNABLE_TO_EVALUATE");
    expect(check.corrections).toEqual([]);

    const reservation = f.endpoints.reservePurchaseRpc(planCommand());
    expect(reservation).toMatchObject({ ok: false, error: { code: "WORKBOOK_SCHEMA_INVALID" } });
    expect(f.planRepository.list()).toEqual([]);

    const state = unwrap(f.endpoints.getBootstrap(undefined));
    expect(state.health).not.toBe("HEALTHY");
    expect(state.categories).toEqual([]);
    expect(state.protectedSavings).toBeNaN();
  });
});

describe("completion retry after an interrupted finalization (public RPC surface)", () => {
  it("rechecks account liquidity before completing a reserved plan", () => {
    const f = endpointFixture({ accountBalance: 300000 });
    unwrap(f.endpoints.reservePurchaseRpc(planCommand({ amount: 300000 })));
    f.sheets.get("backend")!.getRange("C2").setValue(1);
    f.flush();

    expect(f.endpoints.completePlanRpc({ actionId: "plan-1" })).toMatchObject({
      ok: false,
      error: { code: "ACCOUNT_LIQUIDITY_EXCEEDED" },
    });
    expect(f.expenses.getRange("B2:F50").getValues().filter((row: unknown[]) => row[1] !== "")).toHaveLength(0);
  });

  // test/integration/completion-service.test.ts already covers this scenario directly against
  // completePlan(); this is the same scenario driven through completePlanRpc, the public surface a
  // real retrying client actually calls, rather than a second copy of the low-level test.
  it("retries a completion whose expense append succeeded but whose finalization was interrupted, without appending a duplicate row", () => {
    const f = endpointFixture();
    unwrap(f.endpoints.reservePurchaseRpc(planCommand({ actionId: "plan-1", amount: 300000 })));

    f.sheetsController.commitThenThrowNextBatchUpdate();
    const interrupted = f.endpoints.completePlanRpc({ actionId: "plan-1" });
    expect(interrupted).toMatchObject({ ok: false, error: { code: "INTERNAL_ERROR" } });
    expect(f.planRepository.list()[0].status).toBe("RESERVED");
    const afterFirstAttempt = f.expenses.getRange("B2:F50").getValues().filter((row: unknown[]) => row[1] !== "");
    expect(afterFirstAttempt).toHaveLength(1); // the row was truly written before the dropped acknowledgment

    const retried = unwrap(f.endpoints.completePlanRpc({ actionId: "plan-1" }));
    expect(retried.result.status).toBe("COMPLETED");
    const afterRetry = f.expenses.getRange("B2:F50").getValues().filter((row: unknown[]) => row[1] !== "");
    expect(afterRetry).toHaveLength(1); // no duplicate append on retry
    expect(f.sheetsController.metadataCount()).toBe(1);
  });

  it("reconciles an interrupted completion before expiring it after month rollover", () => {
    const f = endpointFixture();
    unwrap(f.endpoints.reservePurchaseRpc(planCommand()));
    f.sheetsController.commitThenThrowNextBatchUpdate();
    expect(f.endpoints.completePlanRpc({ actionId: "plan-1" })).toMatchObject({ ok: false });

    f.advanceTo(new Date("2026-10-01T00:00:00Z"));
    f.sheets.get("backend")!.getRange("G2").setValue("2026-10-01");
    f.sheets.get("Catat - Pendapatan")!.getRange("B2").setValue(new Date("2026-10-01T00:00:00+07:00"));
    f.flush();

    unwrap(f.endpoints.getBootstrap(undefined));
    expect(f.planRepository.list()[0]?.status).toBe("COMPLETED");
    expect(f.expenses.getRange("B2:F50").getValues().filter((row: unknown[]) => row[1] !== "")).toHaveLength(1);
  });
});

describe("repair and health boundaries", () => {
  it("does not expire or serialize financial history when formulas are broken", () => {
    const f = endpointFixture();
    unwrap(f.endpoints.reservePurchaseRpc(planCommand()));
    f.advanceTo(new Date("2026-10-01T00:00:00Z"));
    f.summary.getRange("A2").setFormula("=1/0");

    const state = unwrap(f.endpoints.getBootstrap(undefined));
    expect(state.health).not.toBe("HEALTHY");
    expect(f.planRepository.list()[0]?.status).toBe("RESERVED");
    expect(f.endpoints.getHistoryRpc(undefined)).toMatchObject({ ok: false, error: { code: "WORKBOOK_SCHEMA_INVALID" } });
  });

  it("allows confirmed income to repair a structurally valid underfunded month", () => {
    const f = endpointFixture({ actualIncome: 500000, protectedSavings: 200000 });
    const before = unwrap(f.endpoints.getBootstrap(undefined));
    expect(before.health).toBe("UNDERFUNDED");

    const result = unwrap(f.endpoints.createExpectedIncomeRpc(incomeCommand({ amount: 800000 })));
    expect(result.result.status).toBe("CONFIRMED");
    expect(result.planningState.health).toBe("HEALTHY");
  });
});
