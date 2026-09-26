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

/** The minimal MemorySheet surface the fake Sheets v4 advanced service needs to apply a write. */
export interface FakeSheetsSheet {
  getSheetId(): number;
  getRange(row: number, column: number, numRows?: number, numColumns?: number): { setValues(values: unknown[][]): unknown };
}

export interface FakeSheetsApiController {
  metadataCount(): number;
  /** The next batchUpdate call throws without applying anything: a genuinely rejected request. */
  rejectNextBatchUpdate(): void;
  /** The next batchUpdate call applies its writes, then throws: a lost server acknowledgment. */
  commitThenThrowNextBatchUpdate(): void;
}

const SHEETS_EPOCH_UTC_MS = Date.UTC(1899, 11, 30);

/**
 * Installs a fake global `Sheets` advanced service backed by the given MemorySheet-like sheets.
 * Models Sheets.Spreadsheets.batchUpdate and Sheets.Spreadsheets.DeveloperMetadata.search only,
 * the two calls src/server/workbook/sheets-api.ts makes. A batchUpdate's requests are applied as
 * one atomic operation: either every request is applied, or (on a rejection) none is.
 */
export function installFakeSheetsApi(workbookId: string, sheetsById: () => Map<number, FakeSheetsSheet>, onCommit?: () => void): FakeSheetsApiController {
  const metadata: { sheetId: number; rowIndex: number; key: string; value: string }[] = [];
  let nextFailure: "reject" | "commit-then-throw" | null = null;

  function decodeCell(cell: any): unknown {
    const value = cell.userEnteredValue ?? {};
    if (value.numberValue !== undefined) {
      return cell.userEnteredFormat?.numberFormat?.type === "DATE" ? dateFromSheetsSerial(value.numberValue) : value.numberValue;
    }
    if (value.stringValue !== undefined) return value.stringValue;
    if (value.boolValue !== undefined) return value.boolValue;
    throw new Error("fake Sheets: unsupported cell value");
  }

  function applyUpdateCells(request: any): void {
    const sheet = sheetsById().get(request.range.sheetId);
    if (!sheet) throw new Error("fake Sheets: unknown sheetId in updateCells");
    const values = request.rows[0].values.map(decodeCell);
    sheet.getRange(request.range.startRowIndex + 1, request.range.startColumnIndex + 1, 1, values.length).setValues([values]);
  }

  function applyCreateDeveloperMetadata(request: any): void {
    const location = request.developerMetadata.location.dimensionRange;
    metadata.push({ sheetId: location.sheetId, rowIndex: location.startIndex, key: request.developerMetadata.metadataKey, value: request.developerMetadata.metadataValue });
  }

  (globalThis as any).Sheets = {
    Spreadsheets: {
      DeveloperMetadata: {
        search(resource: any, spreadsheetId: string) {
          if (spreadsheetId !== workbookId) throw new Error("fake Sheets: unknown spreadsheet");
          const lookup = resource?.dataFilters?.[0]?.developerMetadataLookup ?? {};
          const matches = metadata.filter(entry =>
            (lookup.metadataKey === undefined || entry.key === lookup.metadataKey) &&
            (lookup.metadataValue === undefined || entry.value === lookup.metadataValue));
          return {
            matchedDeveloperMetadata: matches.map(entry => ({
              developerMetadata: {
                metadataKey: entry.key, metadataValue: entry.value, visibility: "DOCUMENT",
                location: { dimensionRange: { sheetId: entry.sheetId, dimension: "ROWS", startIndex: entry.rowIndex, endIndex: entry.rowIndex + 1 } },
              },
            })),
          };
        },
      },
      batchUpdate(resource: any, spreadsheetId: string) {
        if (spreadsheetId !== workbookId) throw new Error("fake Sheets: unknown spreadsheet");
        const failure = nextFailure; nextFailure = null;
        if (failure === "reject") throw new Error("fake Sheets: batchUpdate rejected");
        for (const request of resource.requests ?? []) {
          if (request.updateCells) applyUpdateCells(request.updateCells);
          else if (request.createDeveloperMetadata) applyCreateDeveloperMetadata(request.createDeveloperMetadata);
          else throw new Error("fake Sheets: unsupported request kind");
        }
        onCommit?.();
        if (failure === "commit-then-throw") throw new Error("fake Sheets: dropped acknowledgment after commit");
        return { spreadsheetId, replies: (resource.requests ?? []).map(() => ({})) };
      },
    },
  };

  return {
    metadataCount: () => metadata.length,
    rejectNextBatchUpdate: () => { nextFailure = "reject"; },
    commitThenThrowNextBatchUpdate: () => { nextFailure = "commit-then-throw"; },
  };
}

function dateFromSheetsSerial(serial: number): Date {
  return new Date(SHEETS_EPOCH_UTC_MS + serial * 86400000 - 7 * 3600 * 1000);
}
