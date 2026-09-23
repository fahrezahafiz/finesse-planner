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
   those sheet/A1 coordinates to `auditWorkbookStructure(workbook, {
   headerAnchors: [...] })`. This explicit allowlist is required because the
   audit otherwise redacts every value, including strings.
4. Review the resulting JSON offline. It contains sheet names, dimensions,
   named-range coordinates, normalized approved headers, formula locations,
   protected-range boundaries, and a type for every non-header cell. It must
   contain no financial amounts, transaction details, formulas, or other raw
   non-header values.
5. Resolve each exact range and its unique header from that reviewed audit:
   baseline category and planned amount; planned income, planned expenses, and
   protected savings; `Catat - Pengeluaran` B:F; actual income; cash transfer;
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

## Release gate

Before production, repeat the calibration against a current development copy,
run the complete automated suite, and verify that the deployed map is the
reviewed map for the target workbook. The committed structural fixture is
synthetic only; its labels, ranges, dimensions, and formulas are test data and
are not observations of the household workbook.
