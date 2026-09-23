import { describe, expect, it } from "vitest";
import {
  allowedTransferTransitions,
  assertReversibleMonth,
  parseTransferProposal,
  transitionTransfer,
  validateReversal,
  validateTransfer,
  type TransferProposal,
  type TransferSnapshot,
} from "../../src/domain/transfers";
import { parseMoney, parseYearMonth } from "../../src/domain/validation";

function snapshot(overrides: { donorAvailable?: number; recipientAvailable?: number } = {}): TransferSnapshot {
  return {
    categories: {
      Dining: { availableBudget: overrides.donorAvailable ?? 500000 },
      Shopping: { availableBudget: overrides.recipientAvailable ?? 500000 },
    },
  };
}

function proposal(overrides: Partial<TransferProposal> = {}): TransferProposal {
  return {
    actionId: "transfer-1", fromCategory: "Dining", toCategory: "Shopping",
    amount: parseMoney(100000), reason: "Cover shopping overage", relatedPlanId: "",
    ...overrides,
  };
}

describe("validateTransfer", () => {
  it("rejects one rupiah more than donor availability", () => {
    expect(() => validateTransfer(snapshot({ donorAvailable: 100000 }), {
      amount: parseMoney(100001),
      fromCategory: "Dining",
      toCategory: "Shopping",
    })).toThrow("DONOR_BUDGET_EXCEEDED");
  });

  it("allows a transfer exactly equal to donor availability", () => {
    expect(() => validateTransfer(snapshot({ donorAvailable: 100000 }), {
      amount: parseMoney(100000), fromCategory: "Dining", toCategory: "Shopping",
    })).not.toThrow();
  });

  it("rejects an unknown donor or recipient category", () => {
    expect(() => validateTransfer(snapshot(), { amount: parseMoney(1), fromCategory: "Unknown", toCategory: "Shopping" })).toThrow("INVALID_INPUT");
    expect(() => validateTransfer(snapshot(), { amount: parseMoney(1), fromCategory: "Dining", toCategory: "Unknown" })).toThrow("INVALID_INPUT");
  });
});

describe("parseTransferProposal", () => {
  it("rejects identical donor and recipient categories", () => {
    expect(() => parseTransferProposal(proposal({ fromCategory: "Dining", toCategory: "Dining" }))).toThrow("INVALID_INPUT");
  });

  it("rejects the protected-savings category as donor", () => {
    expect(() => parseTransferProposal(proposal({ fromCategory: "Savings" }))).toThrow("INVALID_INPUT");
  });

  it("rejects the protected-savings category as recipient", () => {
    expect(() => parseTransferProposal(proposal({ toCategory: "Savings" }))).toThrow("INVALID_INPUT");
  });

  it.each([0, -1, 1.5, "100000", Number.MAX_SAFE_INTEGER + 1])("rejects unsafe or nonpositive amount %s", amount => {
    expect(() => parseTransferProposal(proposal({ amount: amount as never }))).toThrow("INVALID_AMOUNT");
  });

  it.each([{ actionId: " " }, { fromCategory: "" }, { toCategory: " " }, { reason: "" }, { actionId: "=IMPORTXML(x)" }])("rejects missing or unsafe identities %j", fields => {
    expect(() => parseTransferProposal(proposal(fields))).toThrow("INVALID_INPUT");
  });

  it("allows an optional related plan ID to be blank", () => {
    expect(parseTransferProposal(proposal({ relatedPlanId: "" })).relatedPlanId).toBe("");
  });

  it("rejects a malformed related plan ID", () => {
    expect(() => parseTransferProposal(proposal({ relatedPlanId: " " }))).toThrow("INVALID_INPUT");
  });
});

describe("transitionTransfer", () => {
  it("allows an active transfer to become reversed", () => {
    expect(transitionTransfer("ACTIVE", "REVERSED")).toBe("REVERSED");
  });

  it("rejects reactivating a reversed transfer", () => {
    expect(() => transitionTransfer("REVERSED", "ACTIVE")).toThrow("INVALID_INPUT");
  });

  it("rejects repeating a reversal on an already-reversed transfer", () => {
    expect(() => transitionTransfer("REVERSED", "REVERSED")).toThrow("INVALID_INPUT");
  });

  it("rejects a same-state active transition", () => {
    expect(() => transitionTransfer("ACTIVE", "ACTIVE")).toThrow("INVALID_INPUT");
  });

  it("has exactly the documented transitions", () => {
    expect(allowedTransferTransitions).toEqual({ ACTIVE: ["REVERSED"], REVERSED: [] });
  });
});

describe("validateReversal", () => {
  it("rejects a reversal that would make the recipient negative", () => {
    expect(() => validateReversal(100000, parseMoney(100001))).toThrow("RECIPIENT_BUDGET_EXCEEDED");
  });

  it("allows a reversal exactly equal to recipient availability", () => {
    expect(() => validateReversal(100000, parseMoney(100000))).not.toThrow();
  });
});

describe("assertReversibleMonth", () => {
  it("rejects reversing a transfer outside the currently open month", () => {
    expect(() => assertReversibleMonth(parseYearMonth("2026-08"), parseYearMonth("2026-09"))).toThrow("INVALID_INPUT");
  });

  it("allows reversing a transfer from the currently open month", () => {
    expect(() => assertReversibleMonth(parseYearMonth("2026-09"), parseYearMonth("2026-09"))).not.toThrow();
  });
});
