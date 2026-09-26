# Smoke test runbook

Run this against a real deployment (a development-copy deployment while following
`docs/runbooks/development-copy.md`, or the production deployment during
`docs/runbooks/deploy.md`). It is a small, fast, live check that the deployed app actually behaves
correctly end to end — it is not a substitute for `npm run verify-release`'s automated suite, and it
is not a substitute for the acceptance scenarios in `docs/runbooks/development-copy.md` step 6.

Use small, clearly-synthetic amounts (e.g. Rp 1,000) so a mistake is cheap to spot and cheap to
reverse. Follow the seven steps in exactly this order.

## 1. Load bootstrap with each intended account

1. Signed in as the first intended household account, open the deployed web app URL.
2. Confirm the first viewport loads: protected savings, funded amount, safe-to-plan amount, days
   remaining, and any active reservations.
3. Sign out, sign in as the second intended household account, and repeat.
4. Both accounts must see real household data and their own identity should be usable for audit
   fields (visible in history entries they create later in this runbook).

## 2. Create and cancel a small reservation

1. Use "Check a purchase" for a small, clearly test item (e.g. item "Smoke test item", Rp 1,000, a
   category with headroom, a valid payment account, today's date).
2. Confirm it is recommended, then reserve it.
3. Confirm it appears in active reservations.
4. Cancel the reservation.
5. Confirm it no longer appears in active reservations and the category's available budget is back
   to what it was before step 2.

## 3. Create and reverse a small transfer

1. Transfer a small amount (e.g. Rp 1,000) from one category with headroom to another category.
2. Confirm both categories' adjusted budgets reflect the transfer.
3. Reverse the transfer.
4. Confirm both categories' adjusted budgets are back to what they were before step 3's transfer.

## 4. Create a test plan and complete it twice with the same action ID

1. Reserve a new small test plan (e.g. Rp 1,000, a clearly-labeled test item).
2. Complete it.
3. Confirm it now shows as completed.
4. Retry the same completion once more (the same underlying action; in the UI this means pressing
   "Complete" again, or reloading and completing again, on the same reservation) rather than
   creating a second plan.

## 5. Verify one row and one developer-metadata key

1. Open the workbook directly (not through the app) and check `Catat - Pengeluaran`. Confirm there
   is **exactly one** new row for the test plan from step 4 — the retry in step 4.4 must not have
   produced a second row.
2. Confirm exactly one developer-metadata entry exists for that plan's transaction key (via
   Apps Script's `Sheets.Spreadsheets.DeveloperMetadata.search`, or by re-running the same retry a
   third time and confirming it still reports the same completed result rather than writing again).

## 6. Verify no reservation remains and summary formulas recalculate

1. Confirm the test plan from steps 2 and 4 no longer appears anywhere in active reservations.
2. Confirm `Ringkasan Perencanaan`'s category rows and household summary (`K1:K12`) have
   recalculated to reflect steps 2-4: no error values, no stale numbers, and the reconciliation
   value (transfers in minus transfers out) is exactly zero.

## 7. Verify an unauthorized signed-in account receives no financial data

1. Signed in as a Google account that has **no** access to this workbook, open the deployed web app
   URL.
2. Confirm the app shows **no financial data** of any kind — no protected savings, no budgets, no
   reservations, no transaction history. An access-denied response or an empty/blocked screen is
   correct.
3. If any household figure appears for this account, the smoke test has failed: stop immediately,
   do not mark the deployment checklist's "Smoke test complete" item true, and investigate before
   proceeding.

## After a successful smoke test

If this runbook is being followed against the **development copy**, the rows and transfers created
above simply live in the development copy per `docs/runbooks/development-copy.md` step 6 — there is
nothing further to clean up.

If this runbook is being followed against **production** as part of `docs/runbooks/deploy.md` step
6, the small test rows created in steps 2-4 are real production rows. Do not delete the completed
expense row from step 4/5 (see `docs/runbooks/rollback.md`: completed expense rows are never deleted
automatically, and manual deletion of real ledger history should go through the same household
review any other correction would). It is a real Rp 1,000 test transaction and is harmless to leave
as an auditable record that the smoke test ran; note it as such if your household reviews
`Catat - Pengeluaran` periodically.
