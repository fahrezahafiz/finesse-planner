import type { RequestClock } from "../domain/time";
import { DomainError } from "../domain/errors";
import type { DocumentLock } from "./lock";
import type { WorkbookSourceMap } from "./workbook/source-map";

export const WORKBOOK_ID_PROPERTY = "WORKBOOK_ID";
export const WORKBOOK_SOURCE_MAP_PROPERTY = "WORKBOOK_SOURCE_MAP";

export interface AuthorizationInfoAdapter {
  getAuthorizationStatus(): GoogleAppsScript.Script.AuthorizationStatus;
  getAuthorizationUrl(): string;
}

export interface ServerDeps {
  readonly authModeFull: GoogleAppsScript.Script.AuthMode;
  readonly scriptApp: {
    getAuthorizationInfo(mode: GoogleAppsScript.Script.AuthMode): AuthorizationInfoAdapter;
  };
  readonly session: {
    getActiveUser(): { getEmail(): string };
  };
  readonly spreadsheetApp: {
    openById(id: string): GoogleAppsScript.Spreadsheet.Spreadsheet;
  };
  readonly workbookId: string;
  readonly now: () => Date;
  readonly requestClock?: RequestClock;
  /**
   * Supplied only via the WORKBOOK_SOURCE_MAP Script Property; undefined when the property is
   * absent or fails to parse. Passed through as-is with no shape validation here: the calibrated
   * shape check already lives in validateWorkbookSchema, which fails closed on a falsy or
   * uncalibrated source map, and every service's currentSnapshot() helper already gates on that.
   */
  readonly sourceMap?: WorkbookSourceMap;
  readonly lock?: DocumentLock | null;
}

export function appsScriptDeps(): ServerDeps {
  const workbookId = configuredWorkbookId();

  return {
    authModeFull: ScriptApp.AuthMode.FULL,
    scriptApp: ScriptApp,
    session: Session,
    spreadsheetApp: SpreadsheetApp,
    workbookId,
    now: () => new Date(),
    sourceMap: configuredSourceMap(),
    // Apps Script document locks are null for web-app executions. This deployment targets one
    // configured workbook, so a script-wide lock gives every caller the required shared mutex.
    lock: LockService.getScriptLock(),
  };
}

function configuredWorkbookId(): string {
  try {
    const workbookId = PropertiesService.getScriptProperties()
      .getProperty(WORKBOOK_ID_PROPERTY)
      ?.trim();
    if (workbookId) return workbookId;
  } catch {
    // Configuration failures must not disclose deployment details.
  }

  throw new DomainError("ACCESS_DENIED");
}

/**
 * Best-effort read of the calibrated source map from Script Properties. Its only job is to not
 * crash the process when the property is absent or malformed; the resulting undefined (or a
 * miscalibrated map) is caught downstream by validateWorkbookSchema, which fails closed.
 */
function configuredSourceMap(): WorkbookSourceMap | undefined {
  try {
    const raw = PropertiesService.getScriptProperties().getProperty(WORKBOOK_SOURCE_MAP_PROPERTY);
    if (!raw) return undefined;
    return JSON.parse(raw) as WorkbookSourceMap;
  } catch {
    return undefined;
  }
}
