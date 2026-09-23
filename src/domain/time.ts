import type { LocalDate, YearMonth } from "./types";
import { DomainError } from "./errors";
import { daysInMonth, parseLocalDate, parseYearMonth } from "./validation";

export interface RequestClock {
  nowIso: string;
  today: LocalDate;
  month: YearMonth;
  monthEnd: LocalDate;
  daysRemainingInclusive: number;
}

export function jakartaClock(now: Date): RequestClock {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new DomainError("INVALID_DATE");
  }

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  const year = values.year;
  const monthPart = values.month;
  const day = values.day;
  const hour = values.hour;
  const minute = values.minute;
  const second = values.second;

  if (!year || !monthPart || !day || !hour || !minute || !second) {
    throw new DomainError("INVALID_DATE");
  }

  const today = parseLocalDate(`${year}-${monthPart}-${day}`);
  const month = parseYearMonth(`${year}-${monthPart}`);
  const numericYear = Number(year);
  const numericMonth = Number(monthPart);
  const numericDay = Number(day);
  const finalDay = daysInMonth(numericYear, numericMonth);
  const monthEnd = parseLocalDate(`${year}-${monthPart}-${String(finalDay).padStart(2, "0")}`);
  const milliseconds = String(now.getUTCMilliseconds()).padStart(3, "0");
  const nowIso = `${today}T${hour}:${minute}:${second}.${milliseconds}+07:00`;

  return Object.freeze({
    nowIso,
    today,
    month,
    monthEnd,
    daysRemainingInclusive: finalDay - numericDay + 1,
  });
}
