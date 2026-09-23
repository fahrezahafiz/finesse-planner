import { afterEach, describe, expect, it, vi } from "vitest";
import { appsScriptDeps, WORKBOOK_ID_PROPERTY, WORKBOOK_SOURCE_MAP_PROPERTY } from "../../src/server/deps";

function stubBaseGlobals(properties: Record<string, string | undefined>, lock: unknown = { tryLock: () => true, releaseLock: () => {} }) {
  const getProperty = vi.fn((key: string) => properties[key] ?? null);
  vi.stubGlobal("PropertiesService", {
    getScriptProperties: () => ({ getProperty }),
  });
  vi.stubGlobal("ScriptApp", { AuthMode: { FULL: "FULL" } });
  vi.stubGlobal("Session", {});
  vi.stubGlobal("SpreadsheetApp", { openById: vi.fn() });
  vi.stubGlobal("LockService", { getDocumentLock: () => lock });
  return { getProperty };
}

describe("appsScriptDeps", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the server-controlled workbook property without opening an active spreadsheet", () => {
    const { getProperty } = stubBaseGlobals({ [WORKBOOK_ID_PROPERTY]: " configured-book-id " });

    const deps = appsScriptDeps();

    expect(getProperty).toHaveBeenCalledWith(WORKBOOK_ID_PROPERTY);
    expect(deps.workbookId).toBe("configured-book-id");
    expect("getActiveSpreadsheet" in deps.spreadsheetApp).toBe(false);
  });

  it("fails closed when the workbook property is blank", () => {
    vi.stubGlobal("PropertiesService", {
      getScriptProperties: () => ({ getProperty: () => "   " }),
    });

    expect(() => appsScriptDeps()).toThrow("ACCESS_DENIED");
  });

  it("parses a configured WORKBOOK_SOURCE_MAP property and passes it through as-is", () => {
    const sourceMap = { calibration: { source: "development-copy-audit", auditedAt: "2026-09-23T00:00:00.000Z" }, timeZone: "Asia/Jakarta" };
    stubBaseGlobals({
      [WORKBOOK_ID_PROPERTY]: "book-id",
      [WORKBOOK_SOURCE_MAP_PROPERTY]: JSON.stringify(sourceMap),
    });

    const deps = appsScriptDeps();

    expect(deps.sourceMap).toEqual(sourceMap);
  });

  it("leaves sourceMap undefined when the property is absent, without throwing", () => {
    stubBaseGlobals({ [WORKBOOK_ID_PROPERTY]: "book-id" });

    const deps = appsScriptDeps();

    expect(deps.sourceMap).toBeUndefined();
  });

  it("leaves sourceMap undefined when the property is malformed JSON, without throwing", () => {
    stubBaseGlobals({ [WORKBOOK_ID_PROPERTY]: "book-id", [WORKBOOK_SOURCE_MAP_PROPERTY]: "{not json" });

    const deps = appsScriptDeps();

    expect(deps.sourceMap).toBeUndefined();
  });

  it("passes through LockService.getDocumentLock() as the lock", () => {
    const lock = { tryLock: () => true, releaseLock: () => {} };
    stubBaseGlobals({ [WORKBOOK_ID_PROPERTY]: "book-id" }, lock);

    const deps = appsScriptDeps();

    expect(deps.lock).toBe(lock);
  });
});
