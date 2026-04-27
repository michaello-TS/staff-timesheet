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

3. **Google Sheet** — Tabs: `Timesheet_Submissions` (columns A–P, see data contract below), `Staff_Directory` (payroll output), `Dashboard` (PM approval workflow), `Sync_Log` (Notion sync log).

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
{ "action": "submit", "entries": [{ "staffName": "...", "phoneNumber": "...", "dateOfWork": "YYYY-MM-DD", "workVenue": "...", "basicRate": 0, "startTime": "HH:mm", "endTime": "HH:mm", "pic": "Kamdi|Rufus|Steve|Michael|Not Sure / 未確定", "notes": "..." }] }
```

### Frontend → Backend JSON (status)
```json
{ "action": "status", "phoneNumber": "..." }
```

## Key Technical Notes

- **No build tools** — `index.html` is opened directly in a browser or hosted as-is on GitHub Pages.
- **CORS workaround** — the frontend sends `Content-Type: text/plain`; the backend returns JSON via `ContentService.createTextOutput().setMimeType(ContentService.MimeType.JSON)`.
- **API key security** — any third-party API key (Notion, etc.) must never appear in `index.html`. Keys live only in Apps Script Script Properties (e.g. `NOTION_API_KEY`).
- **Bilingual UI** — all buttons, labels, and messages in `index.html` must display both English and 繁體中文.
- **Mobile-first** — `index.html` uses `max-width: 480px`, buttons ≥48px tall, full-width inputs.

## INVARIANTS (never break these)
- Column order A–P must match across index.html, Code.gs, and Google Sheet simultaneously
- API keys must never appear in index.html — Script Properties only
- Bilingual: every user-facing label has both English and 繁體中文
- Mobile-first: buttons ≥48px, max-width 480px
- PIC dropdown options on the frontend must match the PIC dropdown in the Dashboard (Code.gs `picOptions`)
