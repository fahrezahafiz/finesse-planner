# Production deployment runbook

Run this only after `docs/runbooks/development-copy.md` is fully complete: the development copy has
a calibrated source map, a healthy formula scan, and passing synthetic acceptance transactions, and
`npm run check` passes against this repository. The final `npm run verify-release` is deliberately
post-deployment because it requires truthful production smoke-test attestations. This runbook is what turns that verified
state into a real production release. It is written so a household member without a software
background can follow it exactly; do not skip or reorder steps.

## 1. Stop if sharing is still "Anyone with the link"

1. Open the **production** household workbook (not the development copy) in Google Sheets.
2. Click **Share** in the top-right corner.
3. Look at "General access". If it says **"Anyone with the link"** in any form (viewer, commenter,
   or editor), **stop here**. Do not continue this runbook, and do not deploy the web app, until
   this is fixed by step 2 below. Deploying while the workbook itself is link-shareable would let
   anyone with the link read household financial data or use the app regardless of what the Apps
   Script deployment's own access setting says, because this application treats the workbook's
   Google sharing permissions as its only source of authorization (spec section 12).

## 2. Set sharing to Restricted with exactly the two intended accounts

1. Still under "General access", change it to **Restricted**.
2. Under "People with access", make sure only the two intended household Google accounts are
   listed, each as **Editor** (the app writes IDs, statuses, and audit fields, and needs editor
   access to do so — see `docs/runbooks/workbook-contract.md`'s "Planning sheet contract" section).
3. Remove any other account, group, or link-based access you find.
4. Re-open the Share dialog and re-confirm: General access is **Restricted**, and exactly the two
   intended accounts appear as editors. Do not proceed until this is true.

## 3. Prepare the production script and planning sheets

1. In the **production** workbook, open Extensions > Apps Script. This must be the script project
   bound to the production workbook, separate from the development project used in
   `docs/runbooks/development-copy.md`.
2. Push this repository's verified build (`npm run build`; use the exact commit whose automated
   checks passed and whose `npm run verify-release` stopped only at the not-yet-completable
   deployment checklist) to the production script project.
3. Set the production script project's `WORKBOOK_ID` Script Property to the **production**
   spreadsheet's ID, and `WORKBOOK_SOURCE_MAP` to the source map calibrated against the production
   workbook's actual layout (re-run the audit in `docs/runbooks/workbook-contract.md` against
   production's real headers/ranges if you have not already; the development copy's map is a
   different calibration and must not be reused verbatim unless the layouts are byte-identical).
4. From the Apps Script editor, run the exported `setupPlannerRpc` once as either intended editor.
   Bootstrap never performs setup implicitly. Confirm that `Rencana Pengeluaran`,
   `Transfer Budget`, `Pendapatan Diharapkan`, and `Ringkasan Perencanaan` now exist with the
   expected headers, protections, named ranges, and formulas.
5. Open `Ringkasan Perencanaan` and every calibrated source range. Stop if any required formula is
   blank or shows `#REF!`, `#VALUE!`, `#DIV/0!`, `#N/A`, or another error. Confirm K1:K12 resolves
   to valid numeric/month/date values before deploying the web app.

## 4. Deploy the web app as the accessing user

1. Deploy as a web app with exactly:
   - **Execute as: User accessing the web app** (never "Me" / the deploying account — this is
     `USER_ACCESSING`, not `USER_DEPLOYING`, matching `src/appsscript.json`'s `webapp.executeAs`).
   - **Who has access: Anyone with a Google account** (signed-in Google users only — this is
     `ANYONE` in the manifest, never "Anyone" without sign-in and never restricted to a Google
     Workspace domain). Authorization comes entirely from the workbook's own sharing permissions
     (step 2), not from this setting or from any email allowlist in the app itself.
2. Copy the resulting web app URL. Share it only with the two intended accounts (e.g. by message,
   not by posting it anywhere public — the URL itself grants no access beyond what the workbook
   sharing in step 2 already allows, but there is no reason to publish it more widely).

## 5. Complete OAuth for each intended account

1. Signed in as the **first** intended account, open the web app URL from step 4.
2. Google will prompt for authorization the first time. Review the requested scopes — they should
   be exactly the two scopes in `src/appsscript.json`'s `oauthScopes`
   (`https://www.googleapis.com/auth/spreadsheets` and
   `https://www.googleapis.com/auth/userinfo.email`) — and approve.
3. Confirm the app loads and shows real household data (protected savings, funded amount, category
   budgets).
4. Sign out, sign in as the **second** intended account, and repeat steps 1-3 for that account.
5. If either account cannot complete authorization, or the app fails to load financial data for
   either account, stop and investigate before continuing — do not proceed to step 6 with only one
   account confirmed working.

## 6. Run the denial test

1. Sign in to a Google account that is **not** one of the two intended accounts and has no access
   to the production workbook.
2. Open the web app URL from step 4.
3. Confirm the app returns **no financial data** — no protected savings figure, no category
   budgets, no reservations, nothing that looks like real household numbers. An `ACCESS_DENIED` or
   equivalent access-denied response, or a plainly empty/blocked screen, is correct. Any household
   dollar figure, category name, or account balance appearing here is a failure: stop and
   investigate immediately, and do not consider the deployment complete until this test passes.

## 7. Run the smoke test

Follow `docs/runbooks/smoke-test.md` in full, using the two intended accounts and the unauthorized
account from steps 5-6 above.

## 8. Complete the deployment checklist

`npm run verify-release` (see the repository's `scripts/verify-release.mjs`) refuses to pass unless
a deployment checklist file exists at `release/deployment-checklist.json` (this path is gitignored:
it is per-release, operator-attested state, never something committed to source control) with all
five items set to `true`:

1. Copy `docs/runbooks/deployment-checklist.example.json` to `release/deployment-checklist.json`.
2. Set each item to `true` only once you have personally, truthfully verified it for *this*
   release:
   - `Development copy tested` — step-by-step confirmation you completed
     `docs/runbooks/development-copy.md` for this release's changes.
   - `Production sharing restricted` — confirmation of steps 1-2 above.
   - `Two intended accounts verified` — confirmation of step 5 above for both accounts.
   - `Unauthorized account denied` — confirmation of step 6 above.
   - `Smoke test complete` — confirmation of step 7 above.
3. Run `npm run verify-release` one final time. It re-runs typecheck, the full test suite, the
   build, the manifest-safety check, a build-reproducibility check, and this checklist check. Only
   once it passes cleanly is the release complete.
4. Never set an item to `true` before you have actually done it. This checklist exists specifically
   so that an unfinished or skipped release step fails the automated gate instead of being
   forgotten.
