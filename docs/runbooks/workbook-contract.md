# Workbook contract calibration

The application has no built-in production source map. It must not be deployed
until a development-copy audit has produced the exact labels and A1 ranges used
by the workbook integration. This is intentional: an absent or uncalibrated map
causes `validateWorkbookSchema` to throw `WORKBOOK_SCHEMA_INVALID` before any
financial data is read.

## Development-copy procedure

1. Create a fresh development copy of the household workbook. Do not inspect,
   audit, or write to the production workbook.
2. Set the development deployment's `WORKBOOK_ID` Script Property to that copy.
   The caller-authorized `AuthContext.workbook` is the workbook passed to the
   audit; do not open it again with a different identity.
3. Identify the intended header cells in the development copy. Supply only
   the corresponding sheet/header-row search regions to
   `auditWorkbookStructure(workbook, { headerSearchRegions: [...] })`. This
   explicit allowlist is required because the audit otherwise redacts every
   value, including strings.
4. Review the resulting JSON offline. It contains sheet names, dimensions,
   named-range coordinates, normalized approved headers, formula locations,
   protected-range boundaries, and a type for every non-header cell. It must
   contain no financial amounts, transaction details, formulas, or other raw
   non-header values.
5. Resolve each exact range and its unique header from that reviewed audit:
   baseline category and planned amount; planned income, planned expenses, and
   protected savings; `Catat - Pengeluaran` B:F; actual income date and amount;
   cash transfer;
   calculated account names and balances; formula freshness; and workbook time
   zone. Record them in a deployment-specific `WorkbookSourceMap` with
   `calibration.source` set to `development-copy-audit` and the audit time.
6. Inject that map at the server composition boundary and call
   `validateWorkbookSchema(auth.workbook, sourceMap)` for every request before
   any reader accesses a range. Do not create fallback labels, inferred ranges,
   or a default source map.
7. Re-run the validation after any workbook layout, label, formula, protection,
   or time-zone change. Missing, moved, duplicate, non-unique, or out-of-bounds
   entries must stop the request with `WORKBOOK_SCHEMA_INVALID`.

## Planning sheet contract

Call `setupPlanningSheets(auth, sourceMap)` only against the authorized development
copy after calibration. Both setup and `readPlanningSnapshot(auth, clock, sourceMap)`
validate `auth.workbook`; neither reopens it. An omitted map fails closed. The
income mapping is `{ date, amount }`, with aligned bounded ranges and independent
header anchors on `Catat - Pendapatan`; an amount-only map is not supported.

The four planning sheets hold at most 1,000 data rows each. Existing headers are
preflighted before writes; mismatches and rows beyond that capacity require a
reviewed migration. Ledger IDs and audit fields occupy protected columns, and
editable input ranges are explicit. Setup uses workbook sharing to derive the
two household editors, including the owner, and disables domain-wide protection
editing. Both editors retain protected-range authority because the app executes
as its caller and must write IDs and audit/status fields. Sheets protection is
therefore an editing guard, not a security boundary against those two principals.

The summary uses category headers in A1:H1, bounded category outputs in A2:H1001,
household output labels in J1:J12, and formulas in K1:K12. Stable `FP_` names cover
all calibrated sources and summary outputs. The reader checks those coordinates,
formula identities, required integer-IDR results, and reconciliation with source
and ledger data before returning healthy state. Invalid snapshots carry invalid
health and unknown (`NaN`) monetary fields, never substituted zeroes. Consumers
must gate on health before calculations or serialization; JSON encodes NaN as null.

Calibrate savings-profile outputs and formula freshness as single cells. Freshness
must yield the current Jakarta calendar date (a Sheets date or `yyyy-mm-dd` text).
The workbook time zone must be Asia/Jakarta. Transaction and expected/planned-date
cells must contain real Sheets date values, not text that merely looks like a date.
Budget-month ledger cells use `yyyy-mm` text, matching the summary month formula.
For writes, convert validated local dates into Date values at Jakarta midnight.

Automated tests use synthetic workbook adapters and inspect emitted formulas and
their calculated-value reading contract. Before release, evaluate the formulas in
the calibrated development copy, including duplicate categories, expected-income
date boundaries, transfer reconciliation, and permission behavior for both users.

## Release gate

Before production, repeat the calibration against a current development copy,
run the complete automated suite, and verify that the deployed map is the
reviewed map for the target workbook. The committed structural fixture is
synthetic only; its labels, ranges, dimensions, and formulas are test data and
are not observations of the household workbook.
