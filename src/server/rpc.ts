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
    default:
      return "The request could not be completed.";
  }
}
