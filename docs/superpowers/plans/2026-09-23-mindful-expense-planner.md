# Mindful Expense Planner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Build a mobile-first Google Apps Script web app that evaluates discretionary purchases against workbook budgets, protected savings, and payment-account liquidity; reserves approved or overridden plans; supports month-only transfers and expected income; and converts completed plans into exactly one expense.

**Architecture:** Keep financial calculations in pure TypeScript domain modules and isolate Google APIs behind workbook repositories. A caller-executed Apps Script boundary authorizes each request by opening the workbook under the signed-in user, then uses a document lock, fresh reads, and idempotency keys for every mutation. The workbook owns visible planning formulas and ledgers; the browser receives only the minimum view model needed by four mobile views.

**Tech Stack:** Google Apps Script V8, Google Sheets API v4 advanced service, TypeScript, esbuild, Vitest, jsdom, vanilla HTML/CSS/TypeScript, and clasp.

**Spec:** docs/superpowers/specs/2026-09-23-mindful-expense-planner-design.md

## Global Constraints

- Use a development copy of the workbook for all implementation and acceptance testing.
- Keep the current connector unchanged.
- Deploy only for signed-in Google users and execute as USER_ACCESSING, never USER_DEPLOYING.
- Treat successful workbook access under the caller identity as authorization; do not add an email allowlist.
- Before production, set workbook sharing to Restricted and share it only with the two intended household accounts.
- Fail closed on missing identity, missing OAuth scopes, inaccessible workbook, stale month data, malformed values, formula errors, missing headers, or reconciliation differences.
- Store all money as nonnegative integer IDR amounts and all timestamps in Asia/Jakarta.
- Use a document lock, reload current state after acquiring it, and rerun guardrails before every write.
- Write only the three planning ledgers, the planning summary/setup ranges, approved baseline budget cells, and Catat - Pengeluaran columns B:F during completion.
- Preserve the protected savings target; it is never a transfer category.
- Never automatically alter future baseline budgets.
- Keep body text at least 16px where practical and frequent labels at least 14px, with keyboard focus and enlarged-text support.
- Treat the workbook as the financial source of truth and expose no raw financial rows, formulas, or sheet identifiers to the browser.

## Review Focus

- Two requests with different action IDs arrive for the same final category capacity; the second request must reread under lock and fail if both cannot fit.
- Currency or date inputs contain separators, decimals, invalid calendar dates, or values beyond safe integer range; the server must reject them rather than coerce them.
- Asia/Jakarta crosses midnight or month-end during a request; the server must use one captured clock value and expire past-month reservations consistently.
- Workbook access is revoked, OAuth scope is missing, or a formula becomes an error after the UI loaded; the next server request must return no financial data and perform no write.
- Expense append succeeds but plan finalization is interrupted; retry must find the transaction row by developer metadata and finalize without appending a duplicate.

## Planned File Map

- package.json, tsconfig.json, vitest.config.ts: local build and test contract.
- scripts/build.mjs: bundle server and browser code into deployable Apps Script files.
- scripts/verify-release.mjs: reject unsafe manifest, public-sharing checklist omissions, or dirty build output.
- src/appsscript.json: scopes, advanced Sheets service, Asia/Jakarta time zone, and USER_ACCESSING web-app configuration.
- src/domain/: immutable financial types, validators, recommendation rules, transfers, lifecycle rules, and insights.
- src/server/: authorization, RPC envelopes, locking, clocks, IDs, and service orchestration.
- src/server/workbook/: source-map audit, schema validation, setup, readers, ledger repositories, and atomic Sheets API writer.
- src/client/: application shell, API adapter, state, accessible views, styles, and formatting.
- test/unit/: pure domain and client tests.
- test/integration/: fake workbook, repository, concurrency, security, and RPC tests.
- test/helpers/: reusable domain fixtures and fake Apps Script/workbook adapters.
- test/fixtures/: structural workbook fixtures with synthetic values only.
- docs/runbooks/: development-copy setup, deployment, verification, rollback, and smoke-test instructions.

---

### Task 1: Establish the Apps Script build and test harness

**Files:**
- Create: package.json
- Create: tsconfig.json
- Create: vitest.config.ts
- Create: scripts/build.mjs
- Create: src/appsscript.json
- Create: src/server/main.ts
- Create: src/client/index.html
- Create: src/client/client.ts
- Create: src/client/styles.css
- Create: test/unit/build-contract.test.ts
- Create: .gitignore

**Interfaces:**
- Produces: npm run check, npm run build, and dist/ containing Code.js, Index.html, Client.html, Styles.html, and appsscript.json.
- Consumes: no application interfaces.

- [ ] **Step 1: Initialize the local toolchain**

Run:

~~~bash
npm init -y
npm install --save-dev typescript vitest jsdom @testing-library/dom esbuild @types/google-apps-script @google/clasp
~~~

Set package scripts to:

~~~json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "build": "node scripts/build.mjs",
    "check": "npm run typecheck && npm test && npm run build"
  }
}
~~~

Expected: package-lock.json is created and npm test exits successfully once the smoke test below exists.

- [ ] **Step 2: Write the failing build-contract test**

~~~ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Apps Script manifest", () => {
  it("runs as the accessing signed-in user with the Sheets advanced service", () => {
    const manifest = JSON.parse(readFileSync("src/appsscript.json", "utf8"));
    expect(manifest.timeZone).toBe("Asia/Jakarta");
    expect(manifest.webapp).toEqual({
      access: "ANYONE",
      executeAs: "USER_ACCESSING",
    });
    expect(manifest.dependencies.enabledAdvancedServices).toContainEqual({
      userSymbol: "Sheets",
      serviceId: "sheets",
      version: "v4",
    });
  });
});
~~~

- [ ] **Step 3: Run the test and confirm it fails**

Run: npm test -- test/unit/build-contract.test.ts

Expected: FAIL because src/appsscript.json does not exist.

- [ ] **Step 4: Add the strict compiler, safe manifest, entry points, and deterministic build**

Use ES2020, strict TypeScript, DOM and Google Apps Script types, and no emitted TypeScript output. Configure esbuild to bundle src/server/main.ts as an IIFE into dist/Code.js and src/client/client.ts into a browser IIFE wrapped by dist/Client.html. Copy index.html as Index.html, wrap styles.css in a style element as Styles.html, and copy appsscript.json unchanged.

The manifest must include only these scopes:

~~~json
{
  "timeZone": "Asia/Jakarta",
  "runtimeVersion": "V8",
  "exceptionLogging": "STACKDRIVER",
  "oauthScopes": [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/userinfo.email"
  ],
  "dependencies": {
    "enabledAdvancedServices": [
      {
        "userSymbol": "Sheets",
        "serviceId": "sheets",
        "version": "v4"
      }
    ]
  },
  "webapp": {
    "access": "ANYONE",
    "executeAs": "USER_ACCESSING"
  }
}
~~~

Expose doGet and future RPC functions explicitly:

~~~ts
export function doGet(): GoogleAppsScript.HTML.HtmlOutput {
  return HtmlService.createTemplateFromFile("Index")
    .evaluate()
    .setTitle("Mindful Expense Planner")
    .addMetaTag("viewport", "width=device-width, initial-scale=1");
}

Object.assign(globalThis, { doGet });
~~~

- [ ] **Step 5: Verify and commit**

Run: npm run check

Expected: typecheck passes, the manifest test passes, and all five dist files are generated.

~~~bash
git add package.json package-lock.json tsconfig.json vitest.config.ts scripts src test .gitignore
git commit -m "build: scaffold Apps Script application"
~~~

---

### Task 2: Define domain contracts and strict input validation

**Files:**
- Create: src/domain/types.ts
- Create: src/domain/errors.ts
- Create: src/domain/validation.ts
- Create: src/domain/time.ts
- Create: test/unit/validation.test.ts
- Create: test/unit/time.test.ts
- Create: test/helpers/domain-fixtures.ts

**Interfaces:**
- Produces: Money, LocalDate, YearMonth, Proposal, PlanningSnapshot, Decision, DomainError, parseMoney, parseLocalDate, parseYearMonth, and jakartaClock.
- Consumes: standard JavaScript Date only.

- [ ] **Step 1: Write failing validation boundary tests**

~~~ts
import { describe, expect, it } from "vitest";
import { parseLocalDate, parseMoney } from "../../src/domain/validation";

describe("parseMoney", () => {
  it.each([0, 1, 1250000])("accepts integer IDR %s", value => {
    expect(parseMoney(value)).toBe(value);
  });

  it.each([-1, 1.5, "1.000", Number.MAX_SAFE_INTEGER + 1])(
    "rejects malformed money %s",
    value => expect(() => parseMoney(value)).toThrow("INVALID_AMOUNT"),
  );
});

describe("parseLocalDate", () => {
  it("rejects impossible dates", () => {
    expect(() => parseLocalDate("2026-02-30")).toThrow("INVALID_DATE");
  });
});
~~~

- [ ] **Step 2: Run the tests and confirm missing modules fail**

Run: npm test -- test/unit/validation.test.ts test/unit/time.test.ts

Expected: FAIL because the domain files do not exist.

- [ ] **Step 3: Implement branded values and stable error codes**

~~~ts
export type Money = number & { readonly __money: unique symbol };
export type LocalDate = string & { readonly __localDate: unique symbol };
export type YearMonth = string & { readonly __yearMonth: unique symbol };

export type Verdict =
  | "RECOMMENDED"
  | "NOT_RECOMMENDED"
  | "UNABLE_TO_EVALUATE";

export type PlanStatus =
  | "RESERVED"
  | "OVERRIDDEN"
  | "COMPLETED"
  | "CANCELLED"
  | "EXPIRED";

export interface Proposal {
  actionId: string;
  item: string;
  amount: Money;
  category: string;
  plannedDate: LocalDate;
  paymentAccount: string;
}
~~~

parseMoney must accept only finite safe integers at least zero. Mutation commands additionally require amounts greater than zero. parseLocalDate must round-trip year, month, and day rather than relying on permissive Date parsing.

- [ ] **Step 4: Implement a captured Asia/Jakarta request clock**

~~~ts
export interface RequestClock {
  nowIso: string;
  today: LocalDate;
  month: YearMonth;
  monthEnd: LocalDate;
  daysRemainingInclusive: number;
}

export function jakartaClock(now: Date): RequestClock {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  // Build and validate one immutable request clock from these parts.
}
~~~

Tests must cover 16:59:59Z and 17:00:00Z at Jakarta midnight and the final day of a month.

- [ ] **Step 5: Verify and commit**

Run: npm test -- test/unit/validation.test.ts test/unit/time.test.ts

Expected: all validation and Jakarta boundary tests pass.

~~~bash
git add src/domain test/unit
git commit -m "feat: add strict financial domain contracts"
~~~

---

### Task 3: Enforce workbook-derived authorization at every RPC boundary

**Files:**
- Create: src/server/deps.ts
- Create: src/server/auth.ts
- Create: src/server/rpc.ts
- Modify: src/server/main.ts
- Create: test/unit/auth.test.ts
- Create: test/integration/rpc-security.test.ts
- Create: test/helpers/fake-apps-script.ts

**Interfaces:**
- Produces: authorizeCaller(deps, workbookId): AuthContext and secureRpc(handler).
- Consumes: DomainError from Task 2 and Apps Script Session, ScriptApp, and SpreadsheetApp adapters.
- AuthContext contains email and an already-opened Spreadsheet object; downstream code must not reopen by owner credentials.

- [ ] **Step 1: Write failing authorization tests**

~~~ts
it("returns no data when workbook access fails", () => {
  const deps = fakeDeps({
    email: "outside@example.com",
    openError: new Error("You do not have permission"),
  });

  expect(() => authorizeCaller(deps, "book-id")).toThrow("ACCESS_DENIED");
  expect(deps.audit.financialReadCount).toBe(0);
});

it("denies a blank identity before reading data", () => {
  const deps = fakeDeps({ email: "" });
  expect(() => authorizeCaller(deps, "book-id")).toThrow("IDENTITY_UNAVAILABLE");
});
~~~

- [ ] **Step 2: Run tests and confirm they fail**

Run: npm test -- test/unit/auth.test.ts test/integration/rpc-security.test.ts

Expected: FAIL because authorizeCaller and secureRpc do not exist.

- [ ] **Step 3: Implement fail-closed authorization**

authorizeCaller must:

1. Check ScriptApp.getAuthorizationInfo(AuthMode.FULL).getAuthorizationStatus().
2. Reject REQUIRED with AUTHORIZATION_REQUIRED and include only a safe authorization URL.
3. Require a nonblank normalized Session.getActiveUser().getEmail().
4. Call SpreadsheetApp.openById under the caller-executed deployment.
5. Force a harmless metadata read such as getName() before returning AuthContext.
6. Convert every permission or missing-workbook exception to ACCESS_DENIED without returning the workbook ID, sheet names, or original exception text.

~~~ts
export interface AuthContext {
  email: string;
  workbook: GoogleAppsScript.Spreadsheet.Spreadsheet;
}

export function authorizeCaller(
  deps: ServerDeps,
  workbookId: string,
): AuthContext {
  // Check scopes, identity, and caller-authorized workbook access in this order.
}
~~~

- [ ] **Step 4: Wrap every exported function with one response envelope**

~~~ts
export type RpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; authorizationUrl?: string } };

export function secureRpc<I, O>(
  handler: (input: I, auth: AuthContext, deps: ServerDeps) => O,
): (input: I) => RpcResult<O> {
  // Create request clock, authorize, validate input, and sanitize errors.
}
~~~

Tests must prove unauthorized callers never reach handlers and stack traces never reach clients.

- [ ] **Step 5: Verify and commit**

Run: npm test -- test/unit/auth.test.ts test/integration/rpc-security.test.ts

Expected: all security tests pass.

~~~bash
git add src/server test
git commit -m "feat: derive authorization from workbook access"
~~~

---

### Task 4: Audit and lock the existing workbook contract

**Files:**
- Create: src/server/workbook/source-map.ts
- Create: src/server/workbook/schema.ts
- Create: src/server/workbook/audit.ts
- Create: test/fixtures/workbook-structure.json
- Create: test/unit/workbook-schema.test.ts
- Create: test/helpers/fake-workbook.ts
- Create: docs/runbooks/workbook-contract.md

**Interfaces:**
- Produces: WorkbookSourceMap, auditWorkbookStructure(workbook), and validateWorkbookSchema(workbook, sourceMap).
- Consumes: AuthContext workbook from Task 3.
- Later readers consume only validated ranges from WorkbookSourceMap.

- [ ] **Step 1: Write failing schema tests with synthetic structure**

~~~ts
it("accepts the required existing and planning sheets", () => {
  const result = validateStructure(fixture("healthy"));
  expect(result.sheetNames).toContain("Atur Budgeting");
  expect(result.sheetNames).toContain("Profil Kemampuan Menabung");
  expect(result.expenseInputColumns).toEqual(["B", "C", "D", "E", "F"]);
});

it.each(["missing-sheet", "duplicate-label", "wrong-expense-columns"])(
  "fails closed for %s",
  fixtureName => expect(() => validateStructure(fixture(fixtureName)))
    .toThrow("WORKBOOK_SCHEMA_INVALID"),
);
~~~

- [ ] **Step 2: Run the tests and confirm they fail**

Run: npm test -- test/unit/workbook-schema.test.ts

Expected: FAIL because workbook schema modules do not exist.

- [ ] **Step 3: Implement a read-only structural audit**

The audit records sheet names, dimensions, named ranges, normalized header labels, formula locations, and protected-range boundaries. It must replace every non-header cell value with its type so no financial amounts or transaction details enter fixtures or logs.

Required existing sheets are:

~~~ts
export const REQUIRED_EXISTING_SHEETS = [
  "Atur Budgeting",
  "Profil Kemampuan Menabung",
  "Catat - Pendapatan",
  "Catat - Pengeluaran",
  "Catat - Pindah Kas/Nabung",
  "backend",
] as const;
~~~

Run the audit only against the development copy, review the redacted JSON, and commit it as test/fixtures/workbook-structure.json.

- [ ] **Step 4: Resolve source ranges once and validate every request**

WorkbookSourceMap must identify:

- Baseline category and planned-amount ranges in Atur Budgeting.
- Planned income, planned expenses, and protected monthly savings result in Profil Kemampuan Menabung.
- Date, category, detail, account, and amount in Catat - Pengeluaran columns B:F.
- Actual-income ranges in Catat - Pendapatan.
- Cash-transfer inputs in Catat - Pindah Kas/Nabung.
- Account names and current balances from the calculated workbook view.
- Formula freshness cells and the workbook time zone.

If any label is missing or occurs ambiguously, return WORKBOOK_SCHEMA_INVALID. Exact observed labels and A1 ranges from the redacted audit belong in source-map.ts and docs/runbooks/workbook-contract.md; do not add broad fallback guesses.

- [ ] **Step 5: Verify and commit**

Run: npm test -- test/unit/workbook-schema.test.ts

Expected: healthy fixture passes and every missing, duplicate, or moved contract fails closed.

~~~bash
git add src/server/workbook test/fixtures test/unit docs/runbooks/workbook-contract.md
git commit -m "feat: validate workbook integration contract"
~~~

---

### Task 5: Create planning ledgers and the formula-driven summary

**Files:**
- Create: src/server/workbook/headers.ts
- Create: src/server/workbook/setup.ts
- Create: src/server/workbook/formulas.ts
- Create: src/server/workbook/snapshot-reader.ts
- Create: test/unit/planning-formulas.test.ts
- Create: test/integration/setup-workbook.test.ts

**Interfaces:**
- Produces: setupPlanningSheets(auth), readPlanningSnapshot(auth, clock), and the four sheet header constants.
- Consumes: validated WorkbookSourceMap from Task 4 and domain types from Task 2.
- Produces PlanningSnapshot for Task 6.

- [ ] **Step 1: Write failing setup and formula tests**

~~~ts
it("creates exactly four planning sheets idempotently", () => {
  setupPlanningSheets(fakeAuth());
  setupPlanningSheets(fakeAuth());

  expect(fakeWorkbook().createdSheets()).toEqual([
    "Rencana Pengeluaran",
    "Transfer Budget",
    "Pendapatan Diharapkan",
    "Ringkasan Perencanaan",
  ]);
});

it("aggregates duplicate baseline categories", () => {
  const result = evaluateSummaryFixture({
    baseline: [["Dining", 300000], ["Dining", 200000]],
  });
  expect(result.category("Dining").baselineBudget).toBe(500000);
});
~~~

- [ ] **Step 2: Run tests and confirm they fail**

Run: npm test -- test/unit/planning-formulas.test.ts test/integration/setup-workbook.test.ts

Expected: FAIL because setup and formula modules do not exist.

- [ ] **Step 3: Add exact headers, formatting, protections, and named ranges**

Use the field order from sections 6.1 through 6.4 of the spec. Freeze header rows, format timestamps as date-times, months as yyyy-mm, dates as yyyy-mm-dd, and money as #,##0. Protect formula and ID columns while allowing the two workbook editors to use controlled input ranges.

Create stable named ranges for the validated source ranges and every summary output. setupPlanningSheets must compare existing headers before writing and stop with WORKBOOK_SCHEMA_INVALID rather than reshaping a nonmatching sheet.

- [ ] **Step 4: Generate visible formulas and parse them fail-closed**

Formula builders must emit bounded ranges and these exact relationships:

~~~ts
export const planningMath = {
  adjustedBudget: (baseline: number, transfersIn: number, transfersOut: number) =>
    baseline + transfersIn - transfersOut,
  availableBudget: (adjusted: number, actual: number, reservations: number) =>
    adjusted - actual - reservations,
  spendablePool: (actualIncome: number, futureIncome: number, savings: number) =>
    actualIncome + futureIncome - savings,
  headroom: (pool: number, adjustedBudgets: number) =>
    pool - adjustedBudgets,
};
~~~

The summary reader must reject blank/error/non-numeric required cells, nonzero transfer reconciliation, a stale planning month, or negative headroom by marking health as invalid. It must never translate an error into zero.

- [ ] **Step 5: Verify and commit**

Run: npm test -- test/unit/planning-formulas.test.ts test/integration/setup-workbook.test.ts

Expected: repeated setup is idempotent, duplicate categories aggregate, formula errors fail closed, and transfers reconcile to zero.

~~~bash
git add src/server/workbook test
git commit -m "feat: add planning sheets and summary formulas"
~~~

---

### Task 6: Implement strict recommendations and corrective suggestions

**Files:**
- Create: src/domain/recommendation.ts
- Create: src/domain/corrections.ts
- Create: test/unit/recommendation.test.ts
- Create: test/unit/corrections.test.ts

**Interfaces:**
- Produces: evaluatePurchase(snapshot, proposal): Decision and suggestCorrections(snapshot, proposal, decision): Correction[].
- Consumes: PlanningSnapshot and Proposal from Tasks 2 and 5.
- Decision includes category, savings, household, account, safeDailyAllowance, failedGuardrails, firstFailure, and verdict.

- [ ] **Step 1: Write failing recommendation boundary tests**

~~~ts
it("recommends a purchase exactly equal to category availability", () => {
  const decision = evaluatePurchase(healthySnapshot({
    categoryAvailable: 500000,
  }), proposal({ amount: 500000 }));
  expect(decision.verdict).toBe("RECOMMENDED");
});

it("rejects one rupiah above category availability", () => {
  const decision = evaluatePurchase(healthySnapshot({
    categoryAvailable: 500000,
  }), proposal({ amount: 500001 }));
  expect(decision.verdict).toBe("NOT_RECOMMENDED");
  expect(decision.category.shortfall).toBe(1);
});

it("returns unable when workbook health is invalid", () => {
  const decision = evaluatePurchase(invalidSnapshot("FORMULA_ERROR"), proposal());
  expect(decision.verdict).toBe("UNABLE_TO_EVALUATE");
});
~~~

Add separate tests for savings at target and one rupiah below, account balance with earlier reservations, underfunded month, zero days remaining, and confirmed income after the planned date.

- [ ] **Step 2: Run tests and confirm they fail**

Run: npm test -- test/unit/recommendation.test.ts test/unit/corrections.test.ts

Expected: FAIL because the evaluator does not exist.

- [ ] **Step 3: Implement the five ordered guardrails**

~~~ts
const guardrails = [
  checkPlanningMonthHealth,
  checkCategoryAvailability,
  checkProtectedSavings,
  checkAccountLiquidity,
  checkSchemaAndFormulaHealth,
] as const;

export function evaluatePurchase(
  snapshot: PlanningSnapshot,
  proposal: Proposal,
): Decision {
  // Evaluate every guardrail for explanation, preserve the first failure,
  // and return RECOMMENDED only when every guardrail passes.
}
~~~

Account liquidity must include current balance, confirmed eligible income into that account on or before the planned date, and active reservations with earlier or equal planned dates. Safe daily spending uses inclusive days remaining and clamps at zero.

- [ ] **Step 4: Implement smallest-workable corrections**

Corrections must be deterministic and ordered:

1. Lower price to the minimum of category availability, savings-safe amount, and account-safe amount.
2. Exact zero-sum transfer from donors with sufficient post-transfer availability.
3. Alternate payment account with enough planned-date liquidity.
4. Earliest confirmed-income date that makes the account pass.

Never suggest savings as a donor. If no correction solves every failed guardrail, return an empty list and explain the unresolved first failure.

- [ ] **Step 5: Verify and commit**

Run: npm test -- test/unit/recommendation.test.ts test/unit/corrections.test.ts

Expected: all one-rupiah, ordering, and correction tests pass.

~~~bash
git add src/domain test/unit
git commit -m "feat: add strict purchase recommendations"
~~~

---

### Task 7: Add reservations, overrides, cancellation, and expiration

**Files:**
- Create: src/domain/plans.ts
- Create: src/server/services/plan-service.ts
- Create: src/server/workbook/plan-repository.ts
- Create: src/server/lock.ts
- Create: src/server/idempotency.ts
- Create: test/unit/plans.test.ts
- Create: test/integration/plan-service.test.ts

**Interfaces:**
- Produces: checkPurchase, reservePurchase, overridePurchase, cancelPlan, expirePastPlans.
- Consumes: authorizeCaller, readPlanningSnapshot, evaluatePurchase, DocumentLock, and PlanRepository.
- All commands accept actionId and return the existing result when that actionId was already applied.

- [ ] **Step 1: Write failing lifecycle and concurrency tests**

~~~ts
it("requires a reason for an override", () => {
  expect(() => overridePurchase(command({ reason: "  " }), deps))
    .toThrow("OVERRIDE_REASON_REQUIRED");
});

it("allows at most one of two reservations that cannot both fit", () => {
  const first = reservePurchase(command({ amount: 700000 }), deps);
  const second = reservePurchase(command({ amount: 700000 }), deps);
  expect(first.status).toBe("RESERVED");
  expect(second.error.code).toBe("CATEGORY_BUDGET_EXCEEDED");
});
~~~

Add tests for duplicate actionId, cancel of a terminal plan, and month rollover to EXPIRED.

- [ ] **Step 2: Run tests and confirm they fail**

Run: npm test -- test/unit/plans.test.ts test/integration/plan-service.test.ts

Expected: FAIL because plan services do not exist.

- [ ] **Step 3: Implement lock and idempotency wrappers**

~~~ts
export function withDocumentLock<T>(
  lock: GoogleAppsScript.Lock.Lock,
  action: () => T,
): T {
  if (!lock.tryLock(30000)) throw new DomainError("LOCK_TIMEOUT");
  try {
    return action();
  } finally {
    lock.releaseLock();
  }
}
~~~

Inside the lock, search actionId, expire past-month plans, reload the snapshot, rerun the recommendation, then append or update one plan row. Do not trust a decision produced before lock acquisition.

- [ ] **Step 4: Implement allowed status transitions**

~~~ts
export const allowedTransitions: Record<PlanStatus, PlanStatus[]> = {
  RESERVED: ["COMPLETED", "CANCELLED", "EXPIRED"],
  OVERRIDDEN: ["COMPLETED", "CANCELLED", "EXPIRED"],
  COMPLETED: [],
  CANCELLED: [],
  EXPIRED: [],
};
~~~

Store the original verdict and guardrail snapshots. OVERRIDDEN must reserve money exactly like RESERVED. Expiration uses the captured Jakarta month and never deletes history.

- [ ] **Step 5: Verify and commit**

Run: npm test -- test/unit/plans.test.ts test/integration/plan-service.test.ts

Expected: lifecycle, duplicate action, and competing reservation tests pass.

~~~bash
git add src/domain src/server test
git commit -m "feat: add purchase reservation lifecycle"
~~~

---

### Task 8: Implement month-only transfers and expected income

**Files:**
- Create: src/domain/transfers.ts
- Create: src/domain/expected-income.ts
- Create: src/server/services/transfer-service.ts
- Create: src/server/services/income-service.ts
- Create: src/server/workbook/transfer-repository.ts
- Create: src/server/workbook/income-repository.ts
- Create: test/unit/transfers.test.ts
- Create: test/unit/expected-income.test.ts
- Create: test/integration/transfer-income-service.test.ts

**Interfaces:**
- Produces: createTransfer, reverseTransfer, createExpectedIncome, markIncomeReceived, cancelExpectedIncome.
- Consumes: locks, idempotency, snapshot reader, source categories, and account names.
- Transfer commands preserve total adjusted budget and return a refreshed snapshot.

- [ ] **Step 1: Write failing transfer and income tests**

~~~ts
it("rejects one rupiah more than donor availability", () => {
  expect(() => validateTransfer(snapshot({ donorAvailable: 100000 }), {
    amount: 100001,
    fromCategory: "Dining",
    toCategory: "Shopping",
  })).toThrow("DONOR_BUDGET_EXCEEDED");
});

it("excludes overdue confirmed income", () => {
  const total = eligibleExpectedIncome([
    confirmedIncome({ expectedDate: "2026-09-22", amount: 300000 }),
  ], clock({ today: "2026-09-23" }));
  expect(total).toBe(0);
});
~~~

Add tests for same donor/recipient, protected savings, current-month boundary, reversal that makes recipient negative, received income not double-counted, and cancelled income.

- [ ] **Step 2: Run tests and confirm they fail**

Run: npm test -- test/unit/transfers.test.ts test/unit/expected-income.test.ts test/integration/transfer-income-service.test.ts

Expected: FAIL because transfer and income modules do not exist.

- [ ] **Step 3: Implement transfer creation and reversal under lock**

A transfer amount must be a positive integer, categories must exist and differ, month must be open, and donor availability after actuals and reservations must remain nonnegative. Reversal appends a new reversing row linked to the original and is blocked when the original recipient cannot return the amount.

- [ ] **Step 4: Implement confirmed-income eligibility**

~~~ts
export function countsInForecast(
  entry: ExpectedIncome,
  clock: RequestClock,
): boolean {
  return entry.status === "CONFIRMED"
    && entry.expectedDate >= clock.today
    && entry.expectedDate <= clock.monthEnd;
}
~~~

Destination accounts must exist. RECEIVED and CANCELLED remain in history but contribute zero. Actual income remains owned by Catat - Pendapatan.

- [ ] **Step 5: Verify and commit**

Run: npm test -- test/unit/transfers.test.ts test/unit/expected-income.test.ts test/integration/transfer-income-service.test.ts

Expected: transfer reconciliation remains zero and income date/status tests pass.

~~~bash
git add src/domain src/server test
git commit -m "feat: add transfers and expected income"
~~~

---

### Task 9: Convert completed plans into exactly one actual expense

**Files:**
- Create: src/server/workbook/sheets-api.ts
- Create: src/server/services/completion-service.ts
- Create: test/unit/sheets-api.test.ts
- Create: test/integration/completion-service.test.ts

**Interfaces:**
- Produces: completePlan(command, deps) and appendExpenseWithKey(auth, expense, transactionKey).
- Consumes: Sheets API v4 advanced service, DocumentLock, PlanRepository, and Catat - Pengeluaran B:F contract.
- Developer metadata uses key mindfulExpenseTransaction and value equal to the stable transaction key.

- [ ] **Step 1: Write failing exactly-once tests**

~~~ts
it("returns the existing transaction after a repeated completion request", () => {
  const first = completePlan(completeCommand("action-1"), deps);
  const second = completePlan(completeCommand("action-1"), deps);

  expect(first.transactionKey).toBe(second.transactionKey);
  expect(deps.expenseRows()).toHaveLength(1);
});

it("reconciles after append succeeded but plan finalization failed", () => {
  deps.failOnceAfterAtomicExpenseAppend();
  expect(() => completePlan(completeCommand("action-2"), deps)).toThrow();

  const retry = completePlan(completeCommand("action-2"), deps);
  expect(retry.status).toBe("COMPLETED");
  expect(deps.expenseRows()).toHaveLength(1);
});
~~~

- [ ] **Step 2: Run tests and confirm they fail**

Run: npm test -- test/unit/sheets-api.test.ts test/integration/completion-service.test.ts

Expected: FAIL because completion service does not exist.

- [ ] **Step 3: Implement atomic expense values plus row metadata**

Under the document lock:

1. Reload and validate the plan is RESERVED or OVERRIDDEN.
2. Persist a deterministic transaction key on the plan row.
3. Search developer metadata for that key.
4. If absent, use one Sheets.Spreadsheets.batchUpdate call containing UpdateCellsRequest for B:F and CreateDeveloperMetadataRequest on the same row.
5. Mark the plan COMPLETED with completed timestamp after the atomic batch succeeds.
6. On retry, if metadata exists, skip append and finalize the plan.

The five visible expense cells are date, category, item detail, payment account, and numeric amount. Metadata is document-visible, contains no financial data, and stays attached if the row moves.

- [ ] **Step 4: Test write failures and tuple integrity**

Add tests proving an invalid batch writes neither values nor metadata, a missing metadata match never marks a plan completed, and the row preserves exact date/category/detail/account/amount types.

- [ ] **Step 5: Verify and commit**

Run: npm test -- test/unit/sheets-api.test.ts test/integration/completion-service.test.ts

Expected: all retry, failure-injection, and one-row assertions pass.

~~~bash
git add src/server test
git commit -m "feat: complete plans exactly once"
~~~

---

### Task 10: Add transfer history and recurring-pattern insights

**Files:**
- Create: src/domain/insights.ts
- Create: src/server/services/insight-service.ts
- Create: src/server/services/baseline-review-service.ts
- Create: test/unit/insights.test.ts
- Create: test/integration/baseline-review-service.test.ts

**Interfaces:**
- Produces: analyzeTransferPatterns, proposeBaselineReview, and applyApprovedBaselineChange.
- Consumes: six closed months of active and reversed transfers plus validated baseline cells.
- Suggestions never write. applyApprovedBaselineChange requires a separate actionId and explicit reviewed changes that sum to zero.

- [ ] **Step 1: Write failing recurrence tests**

~~~ts
it("flags a recipient in three of six closed months", () => {
  const result = analyzeTransferPatterns(historyForMonths({
    "2026-03": { Shopping: 100000 },
    "2026-05": { Shopping: 200000 },
    "2026-08": { Shopping: 300000 },
  }), "2026-09");

  expect(result.recurringRecipients[0]).toMatchObject({
    category: "Shopping",
    frequency: 3,
    total: 600000,
    averageMonthlyNet: 200000,
  });
});
~~~

Add tests for exactly two months, current-month exclusion, reversals, recurring donors, rounded averages, and insufficient donor evidence.

- [ ] **Step 2: Run tests and confirm they fail**

Run: npm test -- test/unit/insights.test.ts test/integration/baseline-review-service.test.ts

Expected: FAIL because insight modules do not exist.

- [ ] **Step 3: Implement six-closed-month analysis**

Net all active and reversing entries per category per month. Frequency counts only months with positive recipient net or negative donor net. The average is total net divided by contributing months and rounded to whole IDR.

- [ ] **Step 4: Implement reviewed baseline changes**

A suggestion pairs recipient increases with evidence-backed donor reductions and must sum to zero. Saving requires a second confirmation command, the caller identity, reason, exact cell mapping from WorkbookSourceMap, a document lock, and a fresh baseline read. Reject any changed or missing baseline cell instead of overwriting it.

- [ ] **Step 5: Verify and commit**

Run: npm test -- test/unit/insights.test.ts test/integration/baseline-review-service.test.ts

Expected: pattern, donor evidence, zero-sum, and stale-baseline tests pass.

~~~bash
git add src/domain src/server test
git commit -m "feat: add transfer insights and baseline review"
~~~

---

### Task 11: Publish typed RPC endpoints and minimal view models

**Files:**
- Create: src/server/endpoints.ts
- Create: src/server/view-models.ts
- Modify: src/server/main.ts
- Create: test/integration/endpoints.test.ts

**Interfaces:**
- Produces global functions: getBootstrap, checkPurchaseRpc, reservePurchaseRpc, overridePurchaseRpc, cancelPlanRpc, completePlanRpc, createTransferRpc, reverseTransferRpc, createExpectedIncomeRpc, updateExpectedIncomeRpc, getHistoryRpc, getInsightsRpc, and applyBaselineReviewRpc.
- Consumes: Tasks 3 through 10.
- Browser receives only formatted IDs, labels, monetary integers, dates, statuses, comparisons, corrections, and safe error messages.

- [ ] **Step 1: Write failing endpoint tests**

~~~ts
it("does not expose sheet names, ranges, formulas, or raw rows", () => {
  const response = getBootstrap(undefined, deps);
  const json = JSON.stringify(response);
  expect(json).not.toMatch(/sheetId|range|formula|backend|rawRows/);
});

it("rechecks authorization on every endpoint call", () => {
  getBootstrap(undefined, deps);
  checkPurchaseRpc(validProposal(), deps);
  expect(deps.authorizationChecks).toBe(2);
});
~~~

- [ ] **Step 2: Run tests and confirm they fail**

Run: npm test -- test/integration/endpoints.test.ts

Expected: FAIL because endpoints do not exist.

- [ ] **Step 3: Compose endpoints from secureRpc**

Each endpoint validates unknown input before domain calls. Mutation response view models include actionId and refreshed planning state so the client does not need optimistic financial arithmetic.

- [ ] **Step 4: Export globals for google.script.run**

~~~ts
Object.assign(globalThis, {
  doGet,
  getBootstrap,
  checkPurchaseRpc,
  reservePurchaseRpc,
  overridePurchaseRpc,
  cancelPlanRpc,
  completePlanRpc,
  createTransferRpc,
  reverseTransferRpc,
  createExpectedIncomeRpc,
  updateExpectedIncomeRpc,
  getHistoryRpc,
  getInsightsRpc,
  applyBaselineReviewRpc,
});
~~~

- [ ] **Step 5: Verify and commit**

Run: npm test -- test/integration/endpoints.test.ts

Expected: endpoint authorization, validation, serialization, and data-minimization tests pass.

~~~bash
git add src/server test/integration
git commit -m "feat: expose secure planner endpoints"
~~~

---

### Task 12: Build the mobile application shell and design system

**Files:**
- Modify: src/client/index.html
- Modify: src/client/client.ts
- Modify: src/client/styles.css
- Create: src/client/api.ts
- Create: src/client/state.ts
- Create: src/client/render.ts
- Create: src/client/format.ts
- Create: test/unit/client-shell.test.ts

**Interfaces:**
- Produces: four-view navigation, loading/error/empty states, centralized state, IDR/date formatting, and typed API calls.
- Consumes: Task 11 view models.
- Later client tasks register Plan, Budgets, Transfers, and History renderers.

- [ ] **Step 1: Write failing shell tests in jsdom**

~~~ts
it("renders four labeled navigation destinations", () => {
  renderShell(root(), bootstrapFixture());
  expect(screen.getAllByRole("button").map(button => button.textContent))
    .toEqual(expect.arrayContaining(["Plan", "Budgets", "Transfers", "History"]));
});

it("moves focus to the view heading after navigation", () => {
  navigate("Budgets");
  expect(document.activeElement?.textContent).toBe("Budgets");
});
~~~

- [ ] **Step 2: Run tests and confirm they fail**

Run: npm test -- test/unit/client-shell.test.ts

Expected: FAIL because the client shell does not exist.

- [ ] **Step 3: Implement the semantic shell**

Use a skip link, one main element, one h1 per active view, aria-live status region, native form controls, and bottom navigation buttons with aria-current. Keep navigation fixed without covering content or focused elements.

- [ ] **Step 4: Implement calm responsive styling**

Use CSS custom properties:

~~~css
:root {
  --green-950: #0b2f26;
  --green-800: #155b46;
  --gold-500: #c99a2e;
  --paper: #f7f7f2;
  --surface: #ffffff;
  --ink: #17211d;
  --muted: #65716b;
  --danger: #b42318;
  --focus: #0b6bcb;
  font-size: 16px;
}
~~~

Use red only for concrete failures, minimum 44px tap targets, visible focus outlines, reduced-motion support, and a centered desktop maximum width without changing the phone-first flow.

- [ ] **Step 5: Verify and commit**

Run: npm test -- test/unit/client-shell.test.ts && npm run build

Expected: shell tests pass and client bundle builds.

~~~bash
git add src/client test/unit
git commit -m "feat: add mobile planner shell"
~~~

---

### Task 13: Implement purchase, budget, transfer, and history views

**Files:**
- Create: src/client/views/plan-view.ts
- Create: src/client/views/result-view.ts
- Create: src/client/views/budgets-view.ts
- Create: src/client/views/transfers-view.ts
- Create: src/client/views/history-view.ts
- Create: src/client/views/expected-income-view.ts
- Create: src/client/components/confirm-dialog.ts
- Create: test/unit/plan-view.test.ts
- Create: test/unit/budgets-view.test.ts
- Create: test/unit/transfers-view.test.ts
- Create: test/unit/history-view.test.ts

**Interfaces:**
- Produces every user workflow in sections 7 through 11 of the spec.
- Consumes: shell/state/API from Task 12 and endpoint view models from Task 11.

- [ ] **Step 1: Write failing Plan and result tests**

~~~ts
it("shows exact failed guardrails and correction amounts", () => {
  renderPurchaseResult(notRecommendedFixture({
    categoryShortfall: 50001,
    firstFailure: "CATEGORY_BUDGET_EXCEEDED",
  }));
  expect(screen.getByText("Rp50.001")).toBeTruthy();
  expect(screen.getByText(/shopping budget/i)).toBeTruthy();
});

it("requires confirmation and a reason before override", () => {
  renderPurchaseResult(notRecommendedFixture());
  click("Save with override");
  expect(button("Confirm override").disabled).toBe(true);
  typeInto("Reason", "Needed for work");
  expect(button("Confirm override").disabled).toBe(false);
});
~~~

- [ ] **Step 2: Write failing budget, transfer, income, and history tests**

Cover remaining-amount bars, direct Transfer budget action, donor availability before confirmation, protected savings absent from category selectors, expected-income status updates, active reservation actions, completed/cancelled/expired history, recurring pattern cards, and a review-only baseline suggestion.

- [ ] **Step 3: Run client view tests and confirm they fail**

Run: npm test -- test/unit/plan-view.test.ts test/unit/budgets-view.test.ts test/unit/transfers-view.test.ts test/unit/history-view.test.ts

Expected: FAIL because view modules do not exist.

- [ ] **Step 4: Implement the decision-first flows**

The first viewport shows Check a purchase, protected savings, funded amount, safe-to-plan amount, days remaining, and active reservations. The result view shows verdict text rather than a score, all failed guardrails, with/without comparisons, safe daily allowance, and ordered corrections. Disable repeat submits while a request is pending but always reuse the same generated actionId on retry.

Implement transfer, reversal, expected income, completion, cancellation, and baseline-review confirmation as explicit modal or inline confirmation steps. Escape all user text by assigning textContent, never innerHTML.

- [ ] **Step 5: Verify and commit**

Run: npm test -- test/unit/plan-view.test.ts test/unit/budgets-view.test.ts test/unit/transfers-view.test.ts test/unit/history-view.test.ts && npm run build

Expected: all workflow tests pass and the bundle builds.

~~~bash
git add src/client test/unit
git commit -m "feat: add planner workflows"
~~~

---

### Task 14: Add end-to-end verification, release gates, and deployment runbooks

**Files:**
- Create: test/integration/acceptance.test.ts
- Create: test/integration/concurrency.test.ts
- Create: test/integration/security.test.ts
- Create: scripts/verify-release.mjs
- Create: docs/runbooks/development-copy.md
- Create: docs/runbooks/deploy.md
- Create: docs/runbooks/smoke-test.md
- Create: docs/runbooks/rollback.md
- Modify: package.json

**Interfaces:**
- Produces: npm run verify-release and a repeatable path from development copy to production.
- Consumes: the full application.
- Does not create or alter the production workbook automatically.

- [ ] **Step 1: Encode the 16 acceptance scenarios and failure classes**

Create synthetic integration scenarios for:

- Within-budget dinner recommendation and reservation.
- Shopping shortfall with an exact rupiah amount.
- Valid transfer making a plan safe without reducing savings.
- Savings breach despite sufficient account cash.
- Deliberate override affecting later decisions.
- Exactly-one expense completion.
- Transfer insight and nonautomatic baseline suggestion.
- All calculation, transfer, lifecycle, concurrency, security, and interface cases in section 14 of the spec.
- Revoked access, stale formulas, malformed numbers, and Jakarta month rollover from Review Focus.

- [ ] **Step 2: Implement release verification**

scripts/verify-release.mjs must:

1. Run typecheck, unit/integration tests, and build.
2. Parse dist/appsscript.json and reject any access other than ANYONE or executeAs other than USER_ACCESSING.
3. Confirm the advanced Sheets service and only the two required OAuth scopes.
4. Confirm git diff --exit-code for generated dist output.
5. Require a checked deployment checklist containing Development copy tested, Production sharing restricted, Two intended accounts verified, Unauthorized account denied, and Smoke test complete.

Package script:

~~~json
{
  "scripts": {
    "verify-release": "node scripts/verify-release.mjs"
  }
}
~~~

- [ ] **Step 3: Write the development and deployment runbooks**

The development-copy runbook must require a fresh workbook copy, a separate Apps Script deployment, source-map audit, setupPlanningSheets, formula error scan, and synthetic acceptance transactions that are removed with the copy rather than from production.

The production runbook must explicitly stop if Google Sheets still shows Anyone with the link. It must then require Restricted sharing, the two intended accounts as editors, execute-as-accessing-user deployment, OAuth completion for each account, and a denial test from an account without workbook access.

- [ ] **Step 4: Write smoke test and rollback procedures**

Smoke test order:

1. Load bootstrap with each intended account.
2. Create and cancel a small reservation.
3. Create and reverse a small transfer.
4. Create a test plan and complete it twice with the same actionId.
5. Verify one Catat - Pengeluaran row and one developer-metadata key.
6. Verify no reservation remains and summary formulas recalculate.
7. Verify an unauthorized signed-in account receives no financial data.

Rollback must disable the deployment first, preserve ledgers for audit, restore the previous script deployment, and never delete completed expense rows automatically.

- [ ] **Step 5: Run full verification and commit**

Run: npm run verify-release

Expected: typecheck passes, all tests pass with zero failures, production-unsafe manifest settings are rejected by the release-gate test, build output is reproducible, and the checklist schema is complete.

~~~bash
git add package.json scripts test docs/runbooks
git commit -m "test: add planner acceptance and release gates"
~~~

---

## Plan Completion Checks

Before implementation begins, the implementer must confirm:

- The source workbook is copied for development and no test writes target production.
- Workbook sharing is changed from link-visible to Restricted before any production release.
- The Apps Script deployment executes as the accessing user.
- The redacted workbook-contract audit identifies exact source labels and ranges without retaining financial values.
- The Advanced Sheets service is enabled so expense values and transaction metadata can be written atomically.
- Every task ends with its stated tests and commit.
- npm run verify-release is the final automated gate, followed by the two-account and unauthorized-account manual smoke test.
