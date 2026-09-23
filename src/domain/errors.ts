export type DomainErrorCode =
  | "ACCESS_DENIED"
  | "AUTHORIZATION_REQUIRED"
  | "BASELINE_CELL_STALE"
  | "CATEGORY_BUDGET_EXCEEDED"
  | "DONOR_BUDGET_EXCEEDED"
  | "FORMULA_ERROR"
  | "IDENTITY_UNAVAILABLE"
  | "INVALID_AMOUNT"
  | "INVALID_DATE"
  | "INVALID_INPUT"
  | "INVALID_MONTH"
  | "LOCK_TIMEOUT"
  | "OVERRIDE_REASON_REQUIRED"
  | "RECIPIENT_BUDGET_EXCEEDED"
  | "WORKBOOK_SCHEMA_INVALID";

export class DomainError extends Error {
  readonly code: DomainErrorCode;

  constructor(code: DomainErrorCode) {
    super(code);
    this.name = "DomainError";
    this.code = code;
  }
}
