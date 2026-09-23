import type { RequestClock } from "../domain/time";

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
    getActiveSpreadsheet(): { getId(): string };
  };
  readonly workbookId: string;
  readonly now: () => Date;
  readonly requestClock?: RequestClock;
}

export function appsScriptDeps(): ServerDeps {
  return {
    authModeFull: ScriptApp.AuthMode.FULL,
    scriptApp: ScriptApp,
    session: Session,
    spreadsheetApp: SpreadsheetApp,
    workbookId: SpreadsheetApp.getActiveSpreadsheet().getId(),
    now: () => new Date(),
  };
}
