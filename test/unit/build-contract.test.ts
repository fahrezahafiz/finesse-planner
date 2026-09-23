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
