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
  handler: (input: I, auth: AuthContext, deps: ServerDeps) => O,
  runtime?: RpcRuntime,
): (input: I) => RpcResult<O> {
  return (input: I): RpcResult<O> => {
    try {
      const deps = runtime?.deps ?? appsScriptDeps();
      const requestDeps: ServerDeps = {
        ...deps,
        requestClock: jakartaClock(deps.now()),
      };
      const auth = authorizeCaller(requestDeps, runtime?.workbookId ?? requestDeps.workbookId);

      return { ok: true, data: handler(input, auth, requestDeps) };
    } catch (error) {
      return rpcError(error);
    }
  };
}

function rpcError(error: unknown): RpcResult<never> {
  if (error instanceof AuthorizationRequiredError) {
    return {
      ok: false,
      error: {
        code: error.code,
        message: "Authorization is required to continue.",
        ...(error.authorizationUrl ? { authorizationUrl: error.authorizationUrl } : {}),
      },
    };
  }

  if (error instanceof DomainError) {
    return {
      ok: false,
      error: {
        code: error.code,
        message: publicMessage(error.code),
      },
    };
  }

  return {
    ok: false,
    error: {
      code: "INTERNAL_ERROR",
      message: "The request could not be completed.",
    },
  };
}

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
