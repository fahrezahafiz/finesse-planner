# Rollback runbook

Use this if a production deployment is found to be broken, unsafe, or behaving unexpectedly after
`docs/runbooks/deploy.md`. Follow the steps in order. All four requirements below are mandatory;
do not skip any of them even if the problem seems urgent.

## 1. Disable the deployment first

1. In the production Apps Script project (Extensions > Apps Script, from the production workbook),
   open **Deploy > Manage deployments**.
2. Find the current active web app deployment and set it to **Archived** (or otherwise disable/stop
   it from serving), so the broken web app URL immediately stops responding with new financial data
   or accepting new mutations.
3. Do this **before** touching anything else. The highest priority is to stop further writes or
   further exposure through the broken deployment; investigation and repair come after.

## 2. Preserve ledgers for audit

1. Do not delete, clear, or edit any rows in `Rencana Pengeluaran`, `Transfer Budget`,
   `Pendapatan Diharapkan`, or `Catat - Pengeluaran` as part of rolling back.
2. If the broken deployment wrote incorrect data, leave it in place. Every row already carries the
   audit fields (creator email, timestamps, action IDs, and for expenses a developer-metadata key)
   needed to identify and correct it deliberately later, through the same reviewed mechanisms the
   app itself uses (e.g. a transfer reversal, a plan cancellation) — not through ad hoc row
   deletion.
3. Take a note (outside the workbook, e.g. in this incident's own record) of exactly what looked
   wrong and which rows/action IDs it affected, so a deliberate, reviewed correction can be made
   after the rollback, if one turns out to be necessary.

## 3. Restore the previous script deployment

1. Still under **Deploy > Manage deployments**, identify the last known-good deployment (the one
   active before the broken one).
2. Re-activate it (or create a new deployment from the last known-good version of this repository's
   `main` branch, redeployed the same way `docs/runbooks/deploy.md` describes), so the web app URL
   the two household accounts use now serves the known-good version again.
3. Re-run `docs/runbooks/smoke-test.md` against the restored deployment before telling anyone it is
   safe to use again.
4. Only after the restored deployment passes the smoke test should you begin investigating the root
   cause of the original problem, ideally against a fresh development copy
   (`docs/runbooks/development-copy.md`), never against production directly.

## 4. Never delete completed expense rows automatically

1. Whatever caused the rollback, do not write or run anything — script, formula, manual edit — that
   bulk-deletes or bulk-modifies rows in `Catat - Pengeluaran`, even ones that turn out to have been
   created by a bug.
2. A `Catat - Pengeluaran` row represents a real household financial transaction once it exists,
   whether or not the reservation that produced it was itself correct. If a row genuinely needs to
   be removed (e.g. a confirmed duplicate from a bug, not merely a suspected one), that is a
   deliberate, manual, reviewed household decision made by a person looking at the specific row —
   never an automated step of this rollback runbook, and never something a script performs on the
   household's behalf.
3. This mirrors the application's own design: `src/server/services/completion-service.ts` only ever
   appends exactly one row per completed plan (matched by developer metadata) and never deletes one,
   and spec section 13 requires the app to keep the previous valid state on any recoverable write
   failure rather than remove data.
