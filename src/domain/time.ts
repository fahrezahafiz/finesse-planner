import type { LocalDate, YearMonth } from "./types";
import { daysInMonth, parseLocalDate, parseYearMonth } from "./validation";

export interface RequestClock {
  nowIso: string;
  today: LocalDate;
  month: YearMonth;
  monthEnd: LocalDate;
  daysRemainingInclusive: number;
}

export function jakartaClock(now: Date): RequestClock {
  const nowIso = now.toISOString();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  const year = values.year;
  const monthPart = values.month;
  const day = values.day;

  if (!year || !monthPart || !day) throw new Error("Jakarta date formatting failed");

  const today = parseLocalDate(`${year}-${monthPart}-${day}`);
  const month = parseYearMonth(`${year}-${monthPart}`);
  const numericYear = Number(year);
  const numericMonth = Number(monthPart);
  const numericDay = Number(day);
  const finalDay = daysInMonth(numericYear, numericMonth);
  const monthEnd = parseLocalDate(`${year}-${monthPart}-${String(finalDay).padStart(2, "0")}`);

  return Object.freeze({
    nowIso,
    today,
    month,
    monthEnd,
    daysRemainingInclusive: finalDay - numericDay + 1,
  });
}
