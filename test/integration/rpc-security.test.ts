import { describe, expect, it } from "vitest";
import { DomainError } from "../../src/domain/errors";
import { AuthorizationRequiredError } from "../../src/server/auth";
import { secureRpc } from "../../src/server/rpc";
import { fakeDeps } from "../helpers/fake-apps-script";

describe("secureRpc", () => {
  it("does not invoke a handler when workbook authorization fails", () => {
    const deps = fakeDeps({
      openError: new Error("Permission denied for book-id / Budget!A1"),
    });
    const rpc = secureRpc(
      (input) => input,
      () => {
        deps.audit.handlerCalls += 1;
        return { privateBalance: 999_000 };
      },
      { deps },
    );

    const result = rpc(undefined);

    expect(result).toEqual({
      ok: false,
      error: {
        code: "ACCESS_DENIED",
        message: "Access to this planner is denied.",
      },
    });
    expect(deps.audit.handlerCalls).toBe(0);
    expect(JSON.stringify(result)).not.toMatch(/book-id|Budget!A1|Permission|stack/i);
  });

  it("returns only the safe Apps Script authorization URL when OAuth is required", () => {
    const deps = fakeDeps({ authorizationStatus: "REQUIRED" });
    const rpc = secureRpc((input) => input, () => "financial data", { deps });

    expect(rpc(undefined)).toEqual({
      ok: false,
      error: {
        code: "AUTHORIZATION_REQUIRED",
        message: "Authorization is required to continue.",
        authorizationUrl: "https://script.google.com/macros/d/safe-script-id/usercallback",
      },
    });
  });

  it("does not return an unsafe authorization URL", () => {
    const deps = fakeDeps({
      authorizationStatus: "REQUIRED",
      authorizationUrl: "javascript:alert('book-id')",
    });
    const rpc = secureRpc((input) => input, () => "financial data", { deps });

    expect(rpc(undefined)).toEqual({
      ok: false,
      error: {
        code: "AUTHORIZATION_REQUIRED",
        message: "Authorization is required to continue.",
      },
    });
  });

  it("keeps the authorization-required response safe when its URL cannot be read", () => {
    const deps = fakeDeps({
      authorizationStatus: "REQUIRED",
      authorizationUrlError: new Error("callback URL includes book-id and Budget!A1"),
    });
    const rpc = secureRpc((input) => input, () => "financial data", { deps });

    expect(rpc(undefined)).toEqual({
      ok: false,
      error: {
        code: "AUTHORIZATION_REQUIRED",
        message: "Authorization is required to continue.",
      },
    });
  });

  it("creates one request clock and reauthorizes each request before calling the handler", () => {
    const deps = fakeDeps({ now: new Date("2026-09-23T17:30:00.000Z") });
    const rpc = secureRpc(
      (input) => input,
      (_input, auth, requestDeps) => {
        deps.audit.handlerCalls += 1;
        return {
          email: auth.email,
          nowIso: requestDeps.requestClock?.nowIso,
          workbook: auth.workbook === deps.workbook,
        };
      },
      { deps },
    );

    expect(rpc(undefined)).toEqual({
      ok: true,
      data: {
        email: "member@example.com",
        nowIso: "2026-09-24T00:30:00.000+07:00",
        workbook: true,
      },
    });
    expect(rpc(undefined)).toMatchObject({ ok: true });
    expect(deps.audit.handlerCalls).toBe(2);
    expect(deps.audit.authorizationChecks).toBe(2);
  });

  it("sanitizes unexpected handler failures", () => {
    const deps = fakeDeps();
    const rpc = secureRpc((input) => input, () => {
      throw new Error("Leaked workbook book-id and Budget!A1");
    }, { deps });

    const result = rpc(undefined);

    expect(result).toEqual({
      ok: false,
      error: {
        code: "INTERNAL_ERROR",
        message: "The request could not be completed.",
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/book-id|Budget!A1|stack/i);
  });

  it("authorizes before rejecting malformed unknown input and never invokes the handler", () => {
    const deps = fakeDeps();
    const rpc = secureRpc(
      (input: unknown) => {
        if (typeof input !== "string") throw new DomainError("INVALID_INPUT");
        return input;
      },
      () => {
        deps.audit.handlerCalls += 1;
        return "financial data";
      },
      { deps },
    );

    expect(rpc({ amount: "not an integer" })).toEqual({
      ok: false,
      error: {
        code: "INVALID_INPUT",
        message: "The request could not be completed.",
      },
    });
    expect(deps.audit.calls).toEqual([
      "authorization:FULL",
      "identity",
      "open:book-id",
      "metadata",
    ]);
    expect(deps.audit.handlerCalls).toBe(0);
  });

  it("rejects forged trusted errors and revalidates their authorization URL", () => {
    const deps = fakeDeps();
    const forgedAuthorization = new AuthorizationRequiredError("https://script.google.com@evil.example");
    const rpc = secureRpc(
      (input) => input,
      () => {
        throw forgedAuthorization;
      },
      { deps },
    );

    expect(rpc(undefined)).toEqual({
      ok: false,
      error: {
        code: "AUTHORIZATION_REQUIRED",
        message: "Authorization is required to continue.",
      },
    });

    const forgedCode = Object.assign(new DomainError("ACCESS_DENIED"), {
      code: "INTERNAL_DETAILS:book-id",
    });
    const codeRpc = secureRpc(
      (input) => input,
      () => {
        throw forgedCode;
      },
      { deps },
    );

    expect(codeRpc(undefined)).toEqual({
      ok: false,
      error: {
        code: "INTERNAL_ERROR",
        message: "The request could not be completed.",
      },
    });
  });
});
