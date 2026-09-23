import { describe, expect, it } from "vitest";
import {
  parseLocalDate,
  parseMoney,
  parseYearMonth,
} from "../../src/domain/validation";

describe("parseMoney", () => {
  it.each([0, 1, 1250000])("accepts integer IDR %s", (value) => {
    expect(parseMoney(value)).toBe(value);
  });

  it.each([-1, 1.5, "1.000", Number.MAX_SAFE_INTEGER + 1])(
    "rejects malformed money %s",
    (value) => expect(() => parseMoney(value)).toThrow("INVALID_AMOUNT"),
  );
});

describe("parseLocalDate", () => {
  it("accepts a canonical calendar date", () => {
    expect(parseLocalDate("2026-02-28")).toBe("2026-02-28");
  });

  it("rejects impossible dates", () => {
    expect(() => parseLocalDate("2026-02-30")).toThrow("INVALID_DATE");
  });

  it.each(["2026-2-01", "2026-02-01T00:00:00Z", "not-a-date"])(
    "rejects non-canonical date %s",
    (value) => expect(() => parseLocalDate(value)).toThrow("INVALID_DATE"),
  );
});

describe("parseYearMonth", () => {
  it("accepts a canonical calendar month", () => {
    expect(parseYearMonth("2026-09")).toBe("2026-09");
  });

  it.each(["2026-00", "2026-13", "2026-9", "2026-09-01"])(
    "rejects malformed month %s",
    (value) => expect(() => parseYearMonth(value)).toThrow("INVALID_MONTH"),
  );
});
