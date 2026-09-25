# Development-copy runbook

Everything in this runbook happens against a **development copy** of the household workbook. The
production workbook is never opened, audited, written to, or tested against directly. This mirrors
the rule already established in `docs/runbooks/workbook-contract.md`: the app has no built-in
production source map, and it must not be deployed until a development-copy audit has produced one.

Use this runbook every time before implementing, changing, or re-verifying anything in this
application, and always before running `docs/runbooks/deploy.md`.

## 1. Make a fresh workbook copy

1. Open the real household workbook in Google Sheets (view-only is enough for this step).
2. File > Make a copy. Name it clearly, e.g. `Household Budget (dev copy, 2026-09-23)`.
3. Save the copy outside the shared household Drive folder, then share this copy directly with the
   same two intended household accounts as editors. Setup intentionally refuses any other editor
   count, matching the production authorization model.
4. Do not inspect, audit, or write to the production workbook itself at any point in this runbook.
   Every remaining step in this runbook operates on the copy only.

## 2. Create a separate Apps Script deployment

1. In the development copy, open Extensions > Apps Script. This creates a **project bound to the
   copy**, entirely separate from any script bound to the production workbook.
2. Push this repository's built output to that bound project (`npm run build`, then `clasp push`
   with `.clasp.json` pointed at the development copy's script project — never at the production
   script project's ID).
3. Set the development script project's `WORKBOOK_ID` Script Property to the development copy's
   spreadsheet ID (from its URL), not the production spreadsheet's ID.
4. Deploy this development project as its own web app (Execute as: the accessing user; Who has
   access: only yourself, or Anyone with a Google account for a private development-only URL). This
   deployment's URL and script project are entirely separate from the production deployment
   `docs/runbooks/deploy.md` describes later.

## 3. Audit the workbook contract

Follow `docs/runbooks/workbook-contract.md`'s "Development-copy procedure" section in full:

1. Identify the intended header cells in the development copy.
2. Run `auditWorkbookStructure(workbook, { headerSearchRegions: [...] })` scoped to only those
   regions.
3. Review the resulting JSON offline. Confirm it contains no financial amounts, transaction
   details, formulas, or other raw non-header values — only sheet names, dimensions, named-range
   coordinates, normalized headers, formula locations, protected-range boundaries, and cell types.
4. Resolve the exact ranges into a `WorkbookSourceMap` with `calibration.source` set to
   `development-copy-audit` and the audit timestamp.
5. Set the development script project's `WORKBOOK_SOURCE_MAP` Script Property to that map (JSON).
   Do not invent fallback labels, inferred ranges, or reuse a source map calibrated against a
   different workbook layout.

To run the audit, temporarily set the development project Script Property
`SETUP_AUDIT_ENABLED=true`, then invoke `auditPlannerWorkbookRpc` with
`{headerSearchRegions: [{sheet: "...", row: 1}, ...]}` using only the approved header rows. The RPC
returns only `{logged: true}`; the redacted structural JSON is written to the Apps Script execution
log so it never becomes a browser view model. Download that log for offline review, then immediately
delete `SETUP_AUDIT_ENABLED`. Never set this property in production.

## 4. Run setupPlanningSheets

1. With the audited source map installed, run the exported `setupPlannerRpc` function directly
   from the Apps Script editor as
   either intended editor. This exported, caller-authorized function acquires the script lock and
   calls `setupPlanningSheets` against the configured development copy. Bootstrap never performs
   setup implicitly.
2. Confirm the four planning sheets (`Rencana Pengeluaran`, `Transfer Budget`,
   `Pendapatan Diharapkan`, `Ringkasan Perencanaan`) now exist with the expected headers, protected
   ranges, and named ranges, and that `Ringkasan Perencanaan` carries the calibrated formulas.
3. Re-run this step after any change to the workbook's layout, labels, formulas, protections, or
   time zone, and re-run the contract audit (step 3) first if anything about the source layout
   itself changed.

## 5. Scan for formula errors

1. Open `Ringkasan Perencanaan` and every calibrated source sheet by eye. Look for `#REF!`,
   `#VALUE!`, `#DIV/0!`, `#N/A`, or any other error value in a formula cell.
2. Confirm the household summary cells (`K1:K12`) all resolve to plain numbers, the expected
   `yyyy-mm` month text, and the expected `yyyy-mm-dd` date text — never an error, never blank.
3. Confirm duplicate baseline category rows (if any) aggregate correctly in the summary.
4. If any formula error is found, fix the workbook layout or formulas, then repeat step 3 (audit)
   and step 4 (setup) before continuing. Do not proceed to acceptance testing with a formula error
   present anywhere in the calibrated ranges.

## 6. Run synthetic acceptance transactions

1. Using the development deployment's own URL (step 2) and the development-copy identity, exercise
   the full set of scenarios in `docs/superpowers/specs/2026-09-23-mindful-expense-planner-design.md`
   section 16 and `test/integration/acceptance.test.ts` by hand at least once: a within-budget
   reservation, a shopping shortfall, a budget transfer, a savings-breach rejection, an override, an
   exactly-once completion, and a transfer-pattern/baseline-review round trip.
2. Every reservation, transfer, income entry, and completed expense row created by this step lives
   only in the development copy's own sheets (`Rencana Pengeluaran`, `Transfer Budget`,
   `Pendapatan Diharapkan`, `Catat - Pengeluaran`).
3. **Do not attempt to clean up these synthetic rows by deleting them from production** — they were
   never written to production in the first place, because this entire runbook operates on the
   development copy only. When you are done, discard the synthetic data simply by discarding (or
   archiving, or leaving alone) the development copy itself. The next development cycle starts over
   at step 1 with a fresh copy.
4. Only once every acceptance scenario above passes against the development copy, and the automated
   predeployment suite (`npm run check`) also passes against this repository, proceed to
   `docs/runbooks/deploy.md`.
