import type { Proposal } from "../../src/domain/types";
import { parseLocalDate, parseMoney } from "../../src/domain/validation";

export function validProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    actionId: "action-1",
    item: "Noise-cancelling headphones",
    amount: parseMoney(1250000),
    category: "Shopping",
    plannedDate: parseLocalDate("2026-09-24"),
    paymentAccount: "Main Account",
    ...overrides,
  };
}
