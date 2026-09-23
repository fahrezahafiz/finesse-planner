import { describe, expect, it } from "vitest";
import { authorizeCaller } from "../../src/server/auth";
import { fakeDeps } from "../helpers/fake-apps-script";

describe("authorizeCaller", () => {
  it("opens and verifies the workbook only after scope and identity checks", () => {
    const deps = fakeDeps({ email: "  member@example.com  " });

    const auth = authorizeCaller(deps, "book-id");

    expect(auth.email).toBe("member@example.com");
    expect(auth.workbook).toBe(deps.workbook);
    expect(deps.audit.calls).toEqual([
      "authorization:FULL",
      "identity",
      "open:book-id",
      "metadata",
    ]);
  });

  it("returns no data when workbook access fails", () => {
    const deps = fakeDeps({
      email: "outside@example.com",
      openError: new Error("You do not have permission"),
    });

    expect(() => authorizeCaller(deps, "book-id")).toThrow("ACCESS_DENIED");
    expect(deps.audit.financialReadCount).toBe(0);
  });

  it("denies a blank identity before reading data", () => {
    const deps = fakeDeps({ email: "   " });

    expect(() => authorizeCaller(deps, "book-id")).toThrow("IDENTITY_UNAVAILABLE");
    expect(deps.audit.calls).toEqual(["authorization:FULL", "identity"]);
  });

  it("rejects missing OAuth before consulting the identity or workbook", () => {
    const deps = fakeDeps({ authorizationStatus: "REQUIRED" });

    expect(() => authorizeCaller(deps, "book-id")).toThrow("AUTHORIZATION_REQUIRED");
    expect(deps.audit.calls).toEqual(["authorization:FULL"]);
  });

  it("converts a failed metadata check to a generic access denial", () => {
    const deps = fakeDeps({
      metadataError: new Error("Cannot read Household budget!A1 in book-id"),
    });

    expect(() => authorizeCaller(deps, "book-id")).toThrow("ACCESS_DENIED");
  });
});
