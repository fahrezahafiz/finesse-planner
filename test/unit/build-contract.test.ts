import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Apps Script manifest", () => {
  it("runs as the accessing signed-in user with the Sheets advanced service", () => {
    const manifest = JSON.parse(readFileSync("src/appsscript.json", "utf8"));
    expect(manifest.timeZone).toBe("Asia/Jakarta");
    expect(manifest.webapp).toEqual({
      access: "ANYONE",
      executeAs: "USER_ACCESSING",
    });
    expect(manifest.dependencies.enabledAdvancedServices).toContainEqual({
      userSymbol: "Sheets",
      serviceId: "sheets",
      version: "v4",
    });
  });
});

describe("Apps Script page template", () => {
  it("renders the generated style and client fragments through the server include helper", () => {
    const index = readFileSync("src/client/index.html", "utf8");
    const server = readFileSync("src/server/main.ts", "utf8");

    expect(index).toContain('<?!= include("Styles"); ?>');
    expect(index).toContain('<?!= include("Client"); ?>');
    expect(server).toContain("HtmlService.createHtmlOutputFromFile(filename).getContent()");
    expect(server).toContain("Object.assign(globalThis, { doGet, include })");
  });
});
