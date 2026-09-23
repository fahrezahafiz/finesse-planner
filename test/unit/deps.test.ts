import { afterEach, describe, expect, it, vi } from "vitest";
import { appsScriptDeps, WORKBOOK_ID_PROPERTY } from "../../src/server/deps";

describe("appsScriptDeps", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the server-controlled workbook property without opening an active spreadsheet", () => {
    const getProperty = vi.fn(() => " configured-book-id ");
    vi.stubGlobal("PropertiesService", {
      getScriptProperties: () => ({ getProperty }),
    });
    vi.stubGlobal("ScriptApp", { AuthMode: { FULL: "FULL" } });
    vi.stubGlobal("Session", {});
    vi.stubGlobal("SpreadsheetApp", {
      openById: vi.fn(),
    });

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
});
