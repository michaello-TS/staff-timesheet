# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A zero-cost, automated timesheet system for an event agency. Part-time staff submit job records via a mobile web app; a Google Apps Script backend writes them into a Google Sheet, and a PM-facing Dashboard handles approvals. Approved rows can sync one-way into a Notion HR database.

## Deliverables

All four output files live in `deliverables/`:

| File | What it is |
|------|-----------|
| `index.html` | Staff-facing mobile web app (single file, hosted on GitHub Pages) |
| `Code.gs` | Google Apps Script backend (paste into Apps Script editor in the Google Sheet) |
| `sheet_setup_guide.md` | Step-by-step instructions to create the Google Sheet manually |
| `apps_script_setup.md` | Instructions to deploy the Apps Script as a web app |

## Architecture

The system has three layers that must stay in sync:

1. **Frontend (`index.html`)** — A self-contained HTML/CSS/JS file with no build step. Staff fill structured form fields (date, venue, rate, hours, PIC, notes) per job entry. The app POSTs to the Apps Script URL. The `APPS_SCRIPT_URL` constant near the top of the file must be set by the user after deployment.

2. **Backend (`Code.gs`)** — Google Apps Script. Handles two actions via `doPost(e)`:
   - `action: "submit"` → appends rows to `Timesheet_Submissions` tab, writes `"Pending"` to column N and the formula `=IF(L{row}="", F{row}, F{row}+L{row})` to column M
   - `action: "status"` → returns the staff member's submissions filtered by phone number

3. **Google Sheet** — Tabs: `Timesheet_Submissions` (columns A–P, see data contract below), `Staff_Directory` (payroll output), `Job_Summary` (per-project staff × date rate grid, rebuilt by the same Refresh Payroll click), `Dashboard` (PM approval workflow), `Sync_Log` (Notion sync log).

## Data Contract

Any change to column order, JSON field names, or the `action` values must be updated across **all three layers simultaneously**.

### Google Sheet columns A–P
```
A: Submission Timestamp   B: Staff Name              C: Phone Number
D: Date of Work           E: Work Venue              F: Basic Rate ($)
G: Start Time             H: End Time                I: Notes
J: Project No. (PM fills) K: PIC (Project In-Charge — staff picks; PM may override)
L: OT Compensation (PM fills)
M: Final Rate — formula: =IF(L{row}="", F{row}, F{row}+L{row})
N: Status — always "Pending" on submission
O: Role (PM fills on approve)
P: Synced — auto-stamped by Notion sync
```

### Frontend → Backend JSON (submit)
```json
{ "action": "submit", "accessCode": "...", "entries": [{ "staffName": "...", "phoneNumber": "...", "dateOfWork": "YYYY-MM-DD", "workVenue": "...", "basicRate": 0, "startTime": "HH:mm", "endTime": "HH:mm", "pic": "Kamdi|Rufus|Steve|Michael|Not Sure / 未確定", "notes": "...", "entryId": "e<24 hex>" }] }
```
`phoneNumber` is sent digits-only (the frontend normalizes it before sending).
`entryId` (optional) is a random id per job. The page re-sends the same id when it retries the same unchanged job, and the backend skips any id it has already written in the last 6 hours (CacheService). Backends without this ignore the field; requests without it behave as before.

Submit response: `{ "status": "success", "rowsAdded": n, "duplicates": [entry indexes flagged as possible duplicates], "alreadySaved": [entry indexes skipped because their entryId was already written] }`
Part-way write failure: `{ "status": "error", "message": "...", "rowsAdded": n, "savedEntries": [1-based indexes that ARE in the sheet] }`

**Backward compatibility.** `index.html` must keep working with the previous deployed `Code.gs`, because GitHub Pages serves the new page as soon as it merges, while the backend changes only when the owner pastes it and deploys. The page treats `alreadySaved`/`savedEntries` as optional. When a reply is lost or is an error without `savedEntries`, it checks with a `status` lookup instead. `tests/frontend` runs the new page against both backends.

### Frontend → Backend JSON (status)
```json
{ "action": "status", "accessCode": "...", "phoneNumber": "..." }
```

## Key Technical Notes

- **No build tools** — `index.html` is opened directly in a browser or hosted as-is on GitHub Pages.
- **CORS workaround** — the frontend sends `Content-Type: text/plain`; the backend returns JSON via `ContentService.createTextOutput().setMimeType(ContentService.MimeType.JSON)`.
- **API key security** — any third-party API key (Notion, etc.) must never appear in `index.html`. Keys live only in Apps Script Script Properties (e.g. `NOTION_API_KEY`).
- **Bilingual UI** — all buttons, labels, and messages in `index.html` must display both English and 繁體中文.
- **Mobile-first** — `index.html` uses `max-width: 480px`, buttons ≥48px tall, full-width inputs.
- **Phone canonical form** — digits only (spaces/dashes stripped) at every boundary; column C stores the canonical form.
- **Private server functions** — Apps Script lets any HtmlService page call every *public* server function via `google.script.run`, running as the owner. Only names ending in `_` are private. Keep public only `doGet`/`doPost`, `onOpen`, menu items and the dialog callbacks (`runPayrollForMonths`, `runMarkPaidBatch`, `runSyncForMonths`); `doGet` returns `ContentService` text, never an HtmlService page.
- **Final Rate** — read column M through `_finalRate_(row)` (falls back to F+L; `ok:false` = must be fixed, never paid as $0).
- **Free text → cells** — anything a person typed goes through `_safeText_()` before it is written to a cell (a leading `= + - @` gets an apostrophe, so it can't run as a formula). Project No. cells are formatted as plain text (`@`).
- **Notion limits** — read relation / rich_text properties in full (`_notionPropertyItems_`, since page objects show only 25 items); write the Work Log in 2000-character parts (max 100, oldest lines trimmed); never write more than 100 relation links (at the limit write nothing, leave the row unsynced with a Sync_Log ERROR and a note on its P cell). Column P is stamped right after a row's Notion writes; the sync stops cleanly near 5 minutes (`RUN_START_MS_`).
- **Tests** — `cd tests && npm install && npm test` (see `tests/README.md`). Run them after any change to `Code.gs` or `index.html`.
- **Payment lists** — each Refresh Payroll saves its TO PAY jobs as its own batch (Document Properties `PAY_BATCHES_*`; keys = phone|date|amount|venue|submission timestamp). Mark Approved as Paid shows unpaid batches newest first and flips only the picked batch's still-Approved jobs (`runMarkPaidBatch`). Paid batches are removed, other batches drop jobs no longer Approved, batches expire after 45 days — there is NO count cap, and a refresh identical to the newest unpaid batch is not saved again. Keys are stored once in a shared table (`keys`) and batches refer to them by index, to stay far below the 500 KB Document Properties quota. The picker numbers batches #1 (newest)… with seconds. A timed-out Notion sync is finished with the **Sync to Notion** menu item, never by rebuilding payroll.
- **Sheet time zone** — Date-of-Work cells are formatted in the Sheet's own zone (`_sheetTz_()`); only "now" timestamps use Hong Kong time.

## INVARIANTS (never break these)
- Column order A–P must match across index.html, Code.gs, and Google Sheet simultaneously
- API keys must never appear in index.html — Script Properties only
- Bilingual: every user-facing label has both English and 繁體中文
- Mobile-first: buttons ≥48px, max-width 480px
- PIC dropdown options on the frontend must match the PIC dropdown in the Dashboard (Code.gs `picOptions`)
