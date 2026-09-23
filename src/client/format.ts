/**
 * Pure formatting helpers for the client. No DOM access, no state - just number/string in,
 * display string out, so these are trivial to unit test and safe to call from any renderer.
 */

/**
 * Formats a plain IDR amount (server money values are already validated nonnegative safe
 * integers) as Indonesian Rupiah: "Rp" prefix, "." thousands separator, no decimals.
 * e.g. formatIDR(50001) === "Rp50.001".
 */
export function formatIDR(amount: number): string {
  return `Rp${Math.round(amount).toLocaleString("id-ID")}`;
}

/**
 * Formats a server LocalDate string ("YYYY-MM-DD") for a mobile Indonesian household user as a
 * short, unambiguous date, e.g. "2026-09-24" -> "24 Sep 2026".
 *
 * The date is parsed by its Y/M/D components (not via `new Date(string)`, which treats a bare
 * "YYYY-MM-DD" as UTC midnight) so the result is stable regardless of the viewer's local
 * timezone offset - a LocalDate always means the same calendar day everywhere.
 */
export function formatLocalDate(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  const local = new Date(year, month - 1, day);
  return local.toLocaleDateString("id-ID", { day: "numeric", month: "short", year: "numeric" });
}
