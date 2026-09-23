import type { RequestClock } from "../domain/time";
import { DomainError } from "../domain/errors";

export const WORKBOOK_ID_PROPERTY = "WORKBOOK_ID";

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
