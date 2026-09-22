# Mindful Expense Planner — Design Specification

Date: 2026-09-23  
Status: Approved written specification  
Source workbook: [Finesse Wealth Checker and Tracker](https://docs.google.com/spreadsheets/d/1cS5o9PY6D-P3HS-fpt7zxaOJu37eZPVHSfYKtQ72ywg/edit)

## 1. Purpose

Build a mobile-first Google Apps Script web app for a household of two. The app helps its users decide whether a discretionary purchase is financially safe before committing to it. It must protect the monthly savings target and every category budget strictly, explain the month-end impact of unsafe plans, allow deliberate overrides, and synchronize completed purchases with the existing workbook.

The workbook remains the financial source of truth. The current phone connector is not inspected or modified.

## 2. Success criteria

The product succeeds when:

1. Either authorized account can enter a proposed purchase and receive an understandable recommendation using current workbook data.
2. A purchase is never recommended when it would breach its adjusted category budget, the protected monthly savings target, or the selected payment account's available balance.
3. Planned purchases reserve money until cancelled, expired, or converted to actual spending.
4. A completed plan creates exactly one transaction in `Catat - Pengeluaran` and releases its reservation without double-counting.
5. Month-only budget transfers preserve the total spendable budget and protected savings.
6. Transfer history reveals recurring recipient and donor categories and supports deliberate future-budget review without making automatic changes.
7. Missing, stale, or structurally invalid financial data never produces a positive recommendation.

## 3. Existing workbook model

The app integrates with the workbook's established flow:

- Transaction inputs live in the `Catat - ...` sheets.
- `backend` normalizes transactions for reports and balances.
- `Catat - Pengeluaran` stores expense rows in columns B:F: date, category, detail, account, and amount.
- `Catat - Pendapatan` stores actual income.
- `Catat - Pindah KasNabung` and the workbook's calculated views provide current account balances.
- `Atur Budgeting` contains detailed expense-category budgets in its category and planned-amount columns.
- `Profil Kemampuan Menabung` contains planned monthly income, planned monthly expenses, and the calculated monthly savings capacity.
- The existing dashboards, cash-flow reports, debt model, goals, health score, and wealth level continue to consume the established transaction flow.

The current detailed budget area can contain repeated category labels and may not reconcile to planned income, planned expenses, and savings. The new planning summary must aggregate repeated labels and expose any reconciliation difference before the app can issue recommendations.

## 4. Scope

### Included

- Mobile web app served by Google Apps Script.
- Access control derived from the workbook's Google sharing permissions.
- Purchase planning and strict affordability recommendations.
- Reservations for active plans.
- Month-end financial projections and corrective suggestions.
- Month-only category-to-category transfers.
- A locked protected-savings envelope.
- Confirmed expected-income tracking.
- Deliberate overrides with an audit trail.
- Conversion of completed plans into actual expenses.
- Transfer history, recurring-pattern analysis, and future-budget suggestions.
- Formula-driven planning and reconciliation views inside the workbook.

### Excluded

- Changes to the existing connector.
- Bank connections or automatic transaction ingestion.
- Automatic changes to future baseline budgets.
- Long-term investment, retirement, or debt simulations beyond values already maintained by the workbook.
- Multi-month purchase financing or installment modeling.
- Public access or unauthenticated sharing.
- Offline writes.

## 5. Architecture

Use a separate Apps Script project attached to the workbook. It serves an HTML/CSS/JavaScript mobile interface and uses Apps Script services to read and write the spreadsheet.

Deploy the web app to execute as the user accessing it. Every server entry point opens the workbook under that caller's authority before returning data or attempting a write. Workbook sharing is the authorization source of truth; the app does not maintain a second email allowlist. The signed-in email is still required for audit fields, and missing identity, missing OAuth scopes, or failed workbook access denies the request without returning financial data.

The app reads calculated planning state from `Ringkasan Perencanaan`. It writes only to the three planning ledgers and, when a purchase is completed, the established input columns in `Catat - Pengeluaran`. It never writes directly to `backend`, report sheets, or other calculated ranges.

Core adjusted-budget calculations remain visible in the workbook. The app applies a proposed purchase to those calculated values in memory to provide an immediate what-if decision without temporarily changing shared cells.

All writes use a document lock and an idempotency key. After acquiring the lock, the server reloads current data and reruns the guardrails before committing the action. This prevents two users from spending the same remaining budget and prevents repeated taps from creating duplicate rows.

## 6. New workbook sheets

### 6.1 `Rencana Pengeluaran`

Append-only planning ledger with controlled status updates.

| Field | Purpose |
| --- | --- |
| Plan ID | Stable unique identifier and idempotency key |
| Created at | Audit timestamp in Asia/Jakarta |
| Created by | Authorized Google account |
| Budget month | Calendar month affected by the plan |
| Planned date | Intended purchase date |
| Item | Human-readable purchase description |
| Category | Existing workbook expense category |
| Payment account | Existing workbook cash or credit account |
| Amount | Positive IDR amount |
| Status | `RESERVED`, `OVERRIDDEN`, `COMPLETED`, `CANCELLED`, or `EXPIRED` |
| Verdict | `RECOMMENDED`, `NOT_RECOMMENDED`, or `UNABLE_TO_EVALUATE` |
| Failed guardrails | Structured list of the failed checks |
| Category before / after | Snapshot used for the decision |
| Savings before / after | Snapshot used for the decision |
| Account before / after | Snapshot used for the decision |
| Override reason | Required only for `OVERRIDDEN` |
| Completed at | Timestamp of conversion to actual spending |
| Actual transaction key | Prevents duplicate conversion |

`RESERVED` and `OVERRIDDEN` plans reduce available category and account balances. `COMPLETED`, `CANCELLED`, and `EXPIRED` plans do not reserve money. Past-month unresolved plans become `EXPIRED` during month rollover and remain in history; the user may copy or reschedule them into the current month.

### 6.2 `Transfer Budget`

Append-only month-specific transfer ledger.

| Field | Purpose |
| --- | --- |
| Transfer ID | Stable unique identifier |
| Created at / by | Audit identity and timestamp |
| Budget month | The only month affected |
| From category | Donor category |
| To category | Recipient category |
| Amount | Positive IDR amount |
| Reason | Required human explanation |
| Related plan ID | Optional link to the purchase that prompted the transfer |
| Status | `ACTIVE` or `REVERSED` |
| Reversal reference | Links a reversal to the original transfer |

An active transfer subtracts from one category and adds the same amount to another. The protected-savings envelope cannot be a donor or recipient. A transfer may not make the donor's available budget negative after actual spending and reservations.

### 6.3 `Pendapatan Diharapkan`

Confirmed future-income ledger.

| Field | Purpose |
| --- | --- |
| Expected-income ID | Stable unique identifier |
| Created at / by | Audit identity and timestamp |
| Expected date | Date the income should arrive |
| Source | Salary, project, reimbursement, or another clear source |
| Destination account | Account expected to receive it |
| Amount | Positive IDR amount |
| Status | `CONFIRMED`, `RECEIVED`, or `CANCELLED` |
| Note | Optional context |

Only `CONFIRMED` entries dated from today through the end of the planning month count in forecasts. When an expected date is earlier than today, the entry stops contributing unless actual income has been recorded in `Catat - Pendapatan`. This fail-closed rule prevents overdue expected income from being counted indefinitely. `RECEIVED` is retained for history but is not added on top of actual income.

### 6.4 `Ringkasan Perencanaan`

Visible formula-driven planning and audit view. It contains one monthly household section and one row per aggregated expense category.

Household outputs:

- Actual income recorded for the month.
- Confirmed future income still eligible for the month.
- Total recognized monthly income.
- Protected savings target linked to the workbook's current monthly savings-capacity result.
- Total baseline expense budgets.
- Total adjusted expense budgets.
- Unallocated headroom.
- Funding surplus or shortfall.
- Reconciliation status.

Category outputs:

- Category name.
- Baseline budget aggregated from `Atur Budgeting`.
- Transfers in.
- Transfers out.
- Adjusted budget.
- Actual spending.
- Active reservations.
- Available budget.

The central formulas are:

```text
Adjusted category budget = Baseline budget + Transfers in - Transfers out
Available category budget = Adjusted budget - Actual spending - Active reservations
Spendable pool = Actual income + Confirmed future income - Protected savings
Unallocated headroom = Spendable pool - Total adjusted category budgets
Transfer reconciliation = Total transfers in - Total transfers out
Proposed category overage = MAX(0, Proposed amount - Available category budget)
Projected month-end savings = Recognized monthly income - Total adjusted category budgets - Proposed category overage
Safe daily spending allowance = MAX(0, Total available category budgets - Proposed amount) / Days remaining in month
```

The planning month is funded only when transfer reconciliation equals zero, all required inputs are numeric and current, and unallocated headroom is nonnegative. Negative unallocated headroom means the month is underfunded and blocks positive recommendations. A purchase that fits its category does not reduce projected savings because the category's full adjusted budget is already included in the conservative month-end forecast. Only an unbudgeted overage reduces projected savings.

## 7. Strict recommendation model

The proposed purchase includes item, amount, category, intended date, and payment account.

The app returns `RECOMMENDED` only when all of the following pass after reloading current data:

1. The planning month is fully reconciled and funded.
2. The proposed amount does not exceed the category's available budget.
3. Projected month-end savings remain at or above the protected target.
4. The selected account remains nonnegative on the planned date after current balance, confirmed income to that account before the date, and earlier active reservations are considered.
5. The workbook schema and required formulas are healthy.

The model conservatively assumes that every adjusted category budget may be fully used. Money assigned to another category is not spare money. It becomes available only through an explicit month-only transfer. The savings target is a locked envelope, not an expense category, and cannot fund a transfer.

For a plan above its category budget, the app evaluates available donor categories. A zero-sum transfer may solve the category failure without changing protected savings. If the plan also exceeds household headroom or account liquidity, a transfer alone is insufficient.

The result compares the month with and without the proposed purchase and shows:

- Category budget remaining or shortfall.
- Protected savings at month-end and any target shortfall.
- Household funding surplus or shortfall.
- Selected account balance after the planned date.
- Safe daily spending allowance through month-end.
- The first failing guardrail.
- The smallest workable correction, such as a lower price, a precise transfer, a different payment account, or waiting for confirmed income.

An unsafe plan may be saved only through an explicit override. The user must confirm the action and enter a reason. The status becomes `OVERRIDDEN`, the original verdict remains `NOT_RECOMMENDED`, and the amount reserves money for all later decisions.

## 8. Purchase lifecycle

1. The user enters a proposed purchase.
2. The server reads fresh planning state and evaluates the strict rules.
3. A recommended plan may be reserved directly.
4. A failed plan may be adjusted, paired with a valid transfer, cancelled, or saved with an override.
5. A reservation immediately reduces later planning capacity.
6. When the user marks it purchased, the server reacquires the lock and revalidates the plan.
7. The server appends one row to `Catat - Pengeluaran` using the planned date or confirmed purchase date, category, item detail, payment account, and amount.
8. The server records the actual transaction key and changes the plan to `COMPLETED` in the same locked operation.
9. Workbook formulas recalculate; the completed plan no longer counts as a reservation because the expense now counts as actual spending.

If transaction creation fails, the plan stays reserved and retryable. A repeated completion request with the same action or transaction key returns the existing result without appending another expense.

## 9. Budget-transfer behavior

Transfers affect one calendar month only. A transfer request shows the donor's current available budget before confirmation. The server rejects zero or negative amounts, identical donor and recipient categories, protected savings, missing categories, past closed months, and transfers larger than donor availability.

Reversal creates an auditable reversing entry rather than deleting history. A reversal is blocked if it would make the original recipient category negative after its actual spending and reservations.

Future baseline budgets never change automatically.

## 10. Transfer insights

The transfer page provides current-month activity and historical analysis.

- Show each transfer with month, amount, direction, reason, related plan, and creator.
- Flag a recurring recipient when it receives net budget in at least three of the last six closed months.
- Flag a recurring donor when it contributes net budget in at least three of the last six closed months.
- Show frequency, total amount, and average monthly net transfer.
- A future-budget suggestion uses the rounded average monthly net transfer and pairs increases with evidence-backed donor reductions so the total expense budget remains unchanged.
- If donor evidence is insufficient, show the pattern for review without proposing a saved change.
- Saving a future baseline change requires an explicit review action by an authorized user and updates the appropriate baseline cells in `Atur Budgeting`; the suggestion itself never writes changes.

## 11. User experience

### Navigation

Use four bottom-navigation destinations: `Plan`, `Budgets`, `Transfers`, and `History`.

### Home / Plan

The first viewport is decision-first:

- Prominent `Check a purchase` action.
- Visible protected-savings envelope and funded amount.
- Current safe-to-plan amount and days remaining.
- Active reservations.

Category health appears immediately below active plans, one short scroll away. It shows remaining amounts and consumption bars and includes a direct `Transfer budget` action.

### Purchase result

A strict failure uses plain language and exact amounts. It does not hide the decision behind a score. The screen lists failed guardrails, shows the month-end comparison, and offers precise corrective actions. `Save with override` remains available but visually secondary and requires an additional confirmation plus reason.

### Transfers and patterns

Separate current-month transfers from historical insights. Pattern cards show repeat recipients and donors, their frequency, and average transferred amounts. Future-budget suggestions open a review; they never apply automatically.

### Visual direction

Use a calm, high-contrast financial interface with deep green primary surfaces, a restrained gold planning action, neutral light backgrounds, and red only for concrete failures. Main body text is at least 16px where practical and frequent labels at least 14px. The app is optimized for phone use and remains usable on desktop.

The approved mockups are preserved in `.superpowers/brainstorm/77964-1790096665/content/` as design references, but this specification is complete without them.

## 12. Access and security

- Deploy the web app for signed-in Google users and execute it as the user accessing the app, never as the deploying owner.
- Use the workbook's Google sharing permissions as the only authorization source. Do not maintain a separate application allowlist.
- Open the workbook under the caller's authority before returning any financial data or executing any action. Deny access when the identity is missing, required OAuth scopes are not granted, or workbook access fails.
- Use the verified signed-in email for audit fields only; possessing an email address does not bypass the workbook permission check.
- Share the workbook only with the same two accounts.
- Do not expose sheet identifiers, formulas, or raw financial rows unnecessarily to the browser.
- Validate all server inputs independently of client-side controls.
- Escape user-entered text before rendering it.
- Keep all timestamps in Asia/Jakarta and all monetary values as numeric IDR amounts.

## 13. Error handling

The app fails closed. Missing required values, broken formulas, unexpected sheet names or headers, stale month data, unresolved reconciliation differences, or unavailable account balances produce `UNABLE_TO_EVALUATE` and block writes that depend on the affected result.

User-facing errors identify the needed correction without exposing implementation details. Examples include `Expected income is past due`, `Shopping has no available budget`, `Budget totals exceed this month's funded amount`, and `The payment account balance is unavailable`.

Recoverable write failures keep the previous valid state. A failed purchase conversion leaves the reservation active. A failed transfer writes nothing. The client may safely retry using the same action ID.

## 14. Verification strategy

Development and acceptance testing use a separate copy of the workbook before production deployment.

### Calculation tests

- Purchase exactly equal to remaining category budget.
- Purchase one rupiah over remaining category budget.
- Savings exactly equal to the protected target.
- Savings one rupiah below the protected target.
- Missing, blank, zero, negative, and malformed values.
- Confirmed future income before and after its expected date.
- Account balance with multiple earlier reservations.
- Duplicate category labels aggregated correctly.
- Baseline budgets that do not reconcile to funded income and savings.

### Transfer tests

- Valid zero-sum month-only transfer.
- Transfer equal to donor availability.
- Transfer one rupiah above donor availability.
- Attempted transfer involving protected savings.
- Reversal that would and would not make the recipient negative.
- Month rollover leaves the future baseline unchanged.

### Lifecycle and concurrency tests

- Recommended reservation, cancellation, expiration, and completion.
- Unsafe override with required reason.
- Duplicate completion requests create one actual expense.
- Two simultaneous reservations for the same remaining budget allow at most one when both cannot fit.
- Failed append leaves the reservation active and retryable.
- Completed plans reconcile to exactly one row in `Catat - Pengeluaran`.

### Security and interface tests

- Both workbook-authorized accounts can use the app and their identities appear in audit fields.
- Other signed-in accounts, missing identities, missing required OAuth scopes, and revoked workbook access receive no financial data.
- A deployment configured to execute as the owner fails the release configuration check.
- Mobile layouts remain readable and operable at common phone widths and enlarged text settings.
- All important actions have usable focus states, labels, and confirmation feedback.

## 15. Deployment sequence

1. Copy the workbook for development and verification.
2. Add the planning sheets, headers, formulas, protections, and reconciliation checks to the copy.
3. Build the Apps Script calculation, access-control, and write services.
4. Build the approved mobile interface.
5. Run calculation, concurrency, security, and mobile acceptance tests against the copy.
6. Add the planning sheets and verified formulas to the live workbook.
7. Confirm the workbook is shared only with the two approved accounts and deploy the signed-in web app to execute as the accessing user.
8. Verify both accounts can use the app and a signed-in account without workbook access receives no data.
9. Run a small live smoke test: create and cancel a plan, perform and reverse a small transfer, and convert a test plan exactly once.

## 16. Acceptance scenarios

The implementation is accepted when all of these work end to end:

1. A dinner within its adjusted category budget, funded month, savings target, and account balance is recommended and reserved.
2. Shoes that exceed the shopping budget are not recommended and show the exact category shortfall.
3. A valid month-only transfer makes an otherwise safe purchase recommendable without reducing protected savings.
4. A purchase that would breach protected savings remains not recommended even when the payment account has enough cash.
5. An unsafe purchase can be deliberately overridden and affects later recommendations.
6. A completed reservation appears once in `Catat - Pengeluaran` and no longer appears as reserved.
7. Repeated transfers into one category appear as an insight and produce a reviewable, nonautomatic future-budget suggestion.
