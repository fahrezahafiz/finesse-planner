import { evaluatePurchase, plannedAccountLiquidity } from "./recommendation";
import type { Correction, Decision, Money, PlanningSnapshot, Proposal } from "./types";

/** Returns only independently workable corrections, in the user-facing priority order. */
export function suggestCorrections(snapshot: PlanningSnapshot, proposal: Proposal, decision: Decision): Correction[] {
  if (decision.verdict !== "NOT_RECOMMENDED" || snapshot.health !== "HEALTHY") return [];
  const corrections: Correction[] = [];
  const lowerPrice = lowerPriceCorrection(snapshot, proposal);
  if (lowerPrice) corrections.push(lowerPrice);
  const transfer = transferCorrection(snapshot, proposal);
  if (transfer) corrections.push(transfer);
  const alternate = alternateAccountCorrection(snapshot, proposal);
  if (alternate) corrections.push(alternate);
  const wait = waitForIncomeCorrection(snapshot, proposal);
  if (wait) corrections.push(wait);
  return corrections;
}

function lowerPriceCorrection(snapshot: PlanningSnapshot, proposal: Proposal): Correction | null {
  const category = snapshot.categories[proposal.category];
  const accountLiquidity = plannedAccountLiquidity(snapshot, proposal);
  if (!category || accountLiquidity === null) return null;
  const savingsSafeAmount = category.availableBudget + Math.max(0, snapshot.actualIncome + snapshot.confirmedFutureIncome - snapshot.totalAdjustedBudgets - snapshot.protectedSavingsTarget);
  const householdSafeAmount = category.availableBudget + Math.max(0, snapshot.unallocatedHeadroom);
  const amount = Math.min(category.availableBudget, savingsSafeAmount, householdSafeAmount, accountLiquidity);
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount >= proposal.amount) return null;
  const replacement = { ...proposal, amount: amount as Money };
  return evaluatePurchase(snapshot, replacement).verdict === "RECOMMENDED" ? { kind: "LOWER_PRICE", amount: amount as Money } : null;
}

function transferCorrection(snapshot: PlanningSnapshot, proposal: Proposal): Correction | null {
  const recipient = snapshot.categories[proposal.category];
  if (!recipient) return null;
  const amount = proposal.amount - recipient.availableBudget;
  if (amount <= 0 || !Number.isSafeInteger(amount)) return null;
  for (const [name, donor] of Object.entries(snapshot.categories).sort(([left], [right]) => left.localeCompare(right))) {
    if (name === proposal.category || name === "Savings" || donor.availableBudget < amount) continue;
    const categories = { ...snapshot.categories, [name]: { ...donor, availableBudget: donor.availableBudget - amount }, [proposal.category]: { ...recipient, availableBudget: recipient.availableBudget + amount } };
    if (evaluatePurchase({ ...snapshot, categories }, proposal).verdict === "RECOMMENDED") {
      return { kind: "TRANSFER", fromCategory: name, toCategory: proposal.category, amount: amount as Money };
    }
  }
  return null;
}

function alternateAccountCorrection(snapshot: PlanningSnapshot, proposal: Proposal): Correction | null {
  for (const account of Object.keys(snapshot.accounts).filter(name => name !== proposal.paymentAccount).sort()) {
    if (evaluatePurchase(snapshot, { ...proposal, paymentAccount: account }).verdict === "RECOMMENDED") return { kind: "ALTERNATE_ACCOUNT", paymentAccount: account };
  }
  return null;
}

function waitForIncomeCorrection(snapshot: PlanningSnapshot, proposal: Proposal): Correction | null {
  const dates = [...new Set(snapshot.confirmedIncome
    .filter(income => income.destinationAccount === proposal.paymentAccount && income.expectedDate >= proposal.plannedDate)
    .map(income => income.expectedDate))].sort();
  for (const expectedDate of dates) {
    if (evaluatePurchase(snapshot, { ...proposal, plannedDate: expectedDate }).verdict === "RECOMMENDED") return { kind: "WAIT_FOR_INCOME", expectedDate };
  }
  return null;
}
