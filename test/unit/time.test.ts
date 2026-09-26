import { describe, expect, it } from "vitest";
import { jakartaClock } from "../../src/domain/time";

describe("jakartaClock", () => {
  it("keeps the current Jakarta date just before midnight", () => {
    const clock = jakartaClock(new Date("2026-09-23T16:59:59.000Z"));

    expect(clock).toEqual({
      nowIso: "2026-09-23T23:59:59.000+07:00",
      today: "2026-09-23",
      month: "2026-09",
      monthEnd: "2026-09-30",
      daysRemainingInclusive: 8,
    });
  });

  it("rolls to the next Jakarta date at midnight", () => {
    const clock = jakartaClock(new Date("2026-09-23T17:00:00.000Z"));

    expect(clock).toEqual({
      nowIso: "2026-09-24T00:00:00.000+07:00",
      today: "2026-09-24",
      month: "2026-09",
      monthEnd: "2026-09-30",
      daysRemainingInclusive: 7,
    });
  });

  it("captures the instant with the Jakarta offset", () => {
    const clock = jakartaClock(new Date("2026-09-23T17:00:00.000Z"));

    expect(clock.nowIso).toBe("2026-09-24T00:00:00.000+07:00");
  });

  it("rejects an invalid supplied Date with a stable domain error", () => {
    expect(() => jakartaClock(new Date("not-a-date"))).toThrow("INVALID_DATE");
  });

  it("uses the final calendar day as an inclusive one-day remainder", () => {
    const clock = jakartaClock(new Date("2026-02-28T12:00:00.000Z"));

    expect(clock).toMatchObject({
      today: "2026-02-28",
      month: "2026-02",
      monthEnd: "2026-02-28",
      daysRemainingInclusive: 1,
    });
  });

  it("returns an immutable captured clock", () => {
    const clock = jakartaClock(new Date("2026-09-23T17:00:00.000Z"));

    expect(Object.isFrozen(clock)).toBe(true);
  });
});
