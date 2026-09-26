import { DomainError } from "../domain/errors";
import { jakartaClock } from "../domain/time";
import {
  AuthorizationRequiredError,
  authorizeCaller,
  type AuthContext,
} from "./auth";
import { appsScriptDeps, type ServerDeps } from "./deps";

export type RpcResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      error: { code: string; message: string; authorizationUrl?: string };
    };

export interface RpcRuntime {
  readonly deps?: ServerDeps;
  readonly workbookId?: string;
}

export function secureRpc<I, O>(
  parseInput: (input: unknown) => I,
  handler: (input: I, auth: AuthContext, deps: ServerDeps) => O,
  runtime?: RpcRuntime,
): (input: unknown) => RpcResult<O> {
  return (input: unknown): RpcResult<O> => {
    try {
      const deps = runtime?.deps ?? appsScriptDeps();
      const requestDeps: ServerDeps = {
        ...deps,
        requestClock: jakartaClock(deps.now()),
      };
      const auth = authorizeCaller(requestDeps, runtime?.workbookId ?? requestDeps.workbookId);
      const parsedInput = parseInput(input);

      return { ok: true, data: handler(parsedInput, auth, requestDeps) };
    } catch (error) {
      return rpcError(error);
    }
  };
}

function rpcError(error: unknown): RpcResult<never> {
  if (error instanceof AuthorizationRequiredError) {
    if (error.code !== "AUTHORIZATION_REQUIRED") return internalError();
    const authorizationUrl = safeAuthorizationUrl(error.authorizationUrl);

    return {
      ok: false,
      error: {
        code: error.code,
        message: "Authorization is required to continue.",
        ...(authorizationUrl ? { authorizationUrl } : {}),
      },
    };
  }

  if (error instanceof DomainError) {
    if (!isPublicErrorCode(error.code)) return internalError();

    return {
      ok: false,
      error: {
        code: error.code,
        message: publicMessage(error.code),
      },
    };
  }

  return internalError();
}

function internalError(): RpcResult<never> {
  return {
    ok: false,
    error: {
      code: "INTERNAL_ERROR",
      message: "The request could not be completed.",
    },
  };
}

function isPublicErrorCode(code: unknown): code is DomainError["code"] {
  return typeof code === "string" && PUBLIC_ERROR_CODES.has(code);
}

function safeAuthorizationUrl(value: unknown): string | undefined {
  return typeof value === "string" &&
    /^https:\/\/script\.google\.com(?:\/|$)/.test(value) &&
    !/\s/.test(value)
    ? value
    : undefined;
}

const PUBLIC_ERROR_CODES: ReadonlySet<string> = new Set([
  "ACCESS_DENIED",
  "AUTHORIZATION_REQUIRED",
  "BASELINE_CELL_STALE",
  "ACCOUNT_LIQUIDITY_EXCEEDED",
  "CATEGORY_BUDGET_EXCEEDED",
  "DONOR_BUDGET_EXCEEDED",
  "FORMULA_ERROR",
  "IDENTITY_UNAVAILABLE",
  "INVALID_AMOUNT",
  "INVALID_DATE",
  "INVALID_INPUT",
  "INVALID_MONTH",
  "LOCK_TIMEOUT",
  "OVERRIDE_REASON_REQUIRED",
  "PROTECTED_SAVINGS_EXCEEDED",
  "RECIPIENT_BUDGET_EXCEEDED",
  "WORKBOOK_SCHEMA_INVALID",
]);

function publicMessage(code: DomainError["code"]): string {
  switch (code) {
    case "ACCESS_DENIED":
      return "Access to this planner is denied.";
    case "IDENTITY_UNAVAILABLE":
      return "Your signed-in identity is unavailable.";
    case "AUTHORIZATION_REQUIRED":
      return "Authorization is required to continue.";
    case "INVALID_AMOUNT":
      return "Enter a whole rupiah amount greater than zero.";
    case "INVALID_DATE":
      return "Enter a valid date in the open planning month.";
    case "CATEGORY_BUDGET_EXCEEDED":
      return "This purchase exceeds the category budget.";
    case "ACCOUNT_LIQUIDITY_EXCEEDED":
      return "This payment account cannot cover all scheduled purchases.";
    case "PROTECTED_SAVINGS_EXCEEDED":
      return "This purchase would reduce protected savings below its target.";
    case "DONOR_BUDGET_EXCEEDED":
      return "The donor category does not have enough available budget.";
    case "RECIPIENT_BUDGET_EXCEEDED":
      return "The recipient category no longer has enough budget to reverse this transfer.";
    case "BASELINE_CELL_STALE":
      return "The baseline budget changed. Review the latest values and try again.";
    case "LOCK_TIMEOUT":
      return "Another update is in progress. Please try again.";
    case "WORKBOOK_SCHEMA_INVALID":
    case "FORMULA_ERROR":
      return "The workbook needs attention before this request can continue.";
    case "OVERRIDE_REASON_REQUIRED":
      return "Enter a reason before saving an override.";
    case "INVALID_INPUT":
      return "Check the entered details and try again.";
    default:
      return "The request could not be completed.";
  }
}
