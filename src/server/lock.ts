import { DomainError } from "../domain/errors";

export type DocumentLock = Pick<GoogleAppsScript.Lock.Lock, "tryLock" | "releaseLock">;

export function withDocumentLock<T>(lock: DocumentLock | null, action: () => T): T {
  if (!lock || !lock.tryLock(30000)) throw new DomainError("LOCK_TIMEOUT");
  try { return action(); }
  finally { lock.releaseLock(); }
}
