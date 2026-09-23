import { parseActionId } from "../domain/plans";

/** The action ID is the durable ledger ID; replay returns its current row state. */
export function findAppliedAction<T extends { actionId: string }>(rows: readonly T[], actionId: string): T | undefined {
  parseActionId(actionId);
  return rows.find(row => row.actionId === actionId);
}
