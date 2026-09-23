export interface FakeAppsScriptOptions {
  email?: string;
  authorizationStatus?: "REQUIRED" | "NOT_REQUIRED";
  authorizationUrl?: string;
  authorizationUrlError?: Error;
  openError?: Error;
  metadataError?: Error;
  now?: Date;
}

export interface FakeAppsScriptAudit {
  calls: string[];
  authorizationChecks: number;
  financialReadCount: number;
  handlerCalls: number;
}

export function fakeDeps(options: FakeAppsScriptOptions = {}) {
  const audit: FakeAppsScriptAudit = {
    calls: [],
    authorizationChecks: 0,
    financialReadCount: 0,
    handlerCalls: 0,
  };
  const workbook = {
    getName() {
      audit.calls.push("metadata");
      audit.financialReadCount += 1;
      if (options.metadataError) throw options.metadataError;
      return "Household planner";
    },
  };

  return {
    audit,
    workbook,
    workbookId: "book-id",
    now: () => options.now ?? new Date("2026-09-23T09:00:00.000Z"),
    authModeFull: "FULL",
    scriptApp: {
      getAuthorizationInfo(mode: string) {
        audit.calls.push(`authorization:${mode}`);
        audit.authorizationChecks += 1;
        return {
          getAuthorizationStatus: () => options.authorizationStatus ?? "NOT_REQUIRED",
          getAuthorizationUrl: () =>
            authorizationUrl(options),
        };
      },
    },
    session: {
      getActiveUser() {
        audit.calls.push("identity");
        return { getEmail: () => options.email ?? "member@example.com" };
      },
    },
    spreadsheetApp: {
      openById(workbookId: string) {
        audit.calls.push(`open:${workbookId}`);
        if (options.openError) throw options.openError;
        return workbook;
      },
      getActiveSpreadsheet() {
        return { getId: () => "book-id" };
      },
    },
  };
}

function authorizationUrl(options: FakeAppsScriptOptions): string {
  if (options.authorizationUrlError) throw options.authorizationUrlError;
  return options.authorizationUrl ?? "https://script.google.com/macros/d/safe-script-id/usercallback";
}
