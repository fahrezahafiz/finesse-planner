import { DomainError } from "./errors";
import type { LocalDate, Money, YearMonth } from "./types";

const LOCAL_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const YEAR_MONTH_PATTERN = /^(\d{4})-(\d{2})$/;

export function parseMoney(value: unknown): Money {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new DomainError("INVALID_AMOUNT");
  }

  return value as Money;
}

export function parseLocalDate(value: unknown): LocalDate {
  if (typeof value !== "string") throw new DomainError("INVALID_DATE");

  const match = LOCAL_DATE_PATTERN.exec(value);
  if (!match) throw new DomainError("INVALID_DATE");

  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);

  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw new DomainError("INVALID_DATE");
  }

  return value as LocalDate;
}

export function parseYearMonth(value: unknown): YearMonth {
  if (typeof value !== "string") throw new DomainError("INVALID_MONTH");

  const match = YEAR_MONTH_PATTERN.exec(value);
  if (!match) throw new DomainError("INVALID_MONTH");

  const [, yearText, monthText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  if (year < 1 || month < 1 || month > 12) throw new DomainError("INVALID_MONTH");

  return value as YearMonth;
}

export function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}
