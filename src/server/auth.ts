import { DomainError } from "../domain/errors";
import type { ServerDeps } from "./deps";

export interface AuthContext {
  email: string;
  workbook: GoogleAppsScript.Spreadsheet.Spreadsheet;
}

export class AuthorizationRequiredError extends DomainError {
  readonly authorizationUrl?: string;

  constructor(authorizationUrl?: string) {
    super("AUTHORIZATION_REQUIRED");
    this.name = "AuthorizationRequiredError";
    this.authorizationUrl = authorizationUrl;
  }
}

export function authorizeCaller(deps: ServerDeps, workbookId: string): AuthContext {
  const authorizationInfo = authorizationInfoFor(deps);
  if (String(authorizationInfo.getAuthorizationStatus()) === "REQUIRED") {
    throw new AuthorizationRequiredError(authorizationUrlFor(authorizationInfo));
  }

  const email = activeEmail(deps);
  if (!email) throw new DomainError("IDENTITY_UNAVAILABLE");

  try {
    const workbook = deps.spreadsheetApp.openById(workbookId);
    workbook.getName();
    return { email, workbook };
  } catch {
    throw new DomainError("ACCESS_DENIED");
  }
}

function authorizationInfoFor(deps: ServerDeps) {
  try {
    return deps.scriptApp.getAuthorizationInfo(deps.authModeFull);
  } catch {
    throw new DomainError("ACCESS_DENIED");
  }
}

function activeEmail(deps: ServerDeps): string {
  try {
    const email = deps.session.getActiveUser().getEmail();
    return typeof email === "string" ? email.trim() : "";
  } catch {
    return "";
  }
}

function authorizationUrlFor(
  authorizationInfo: ReturnType<ServerDeps["scriptApp"]["getAuthorizationInfo"]>,
): string | undefined {
  try {
    return safeAuthorizationUrl(authorizationInfo.getAuthorizationUrl());
  } catch {
    return undefined;
  }
}

function safeAuthorizationUrl(value: string): string | undefined {
  return /^https:\/\/script\.google\.com(?:\/|$)/.test(value) && !/\s/.test(value)
    ? value
    : undefined;
}
