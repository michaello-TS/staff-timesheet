# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A zero-cost, automated timesheet system for an event agency. Part-time staff submit job records via a mobile web app; a Google Apps Script backend parses the free-text input using Gemini AI and writes it into a Google Sheet.

## Working with the User

- The user is a non-programmer using vibe coding. Always explain changes in plain English — what was changed and why, without technical jargon.
- Never delete any files without explicitly asking the user first.
- After every update, remind the user to press **Cmd+Shift+R** in their browser to hard-refresh and see the latest changes.

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

1. **Frontend (`index.html`)** — A self-contained HTML/CSS/JS file with no build step. Staff type free-text job descriptions (e.g. `20/2 HKCEC 9am-6pm $600`). The app POSTs to the Apps Script URL twice: once to parse (AI), once to confirm and submit. The `APPS_SCRIPT_URL` constant near the top of the file must be set by the user after deployment.

2. **Backend (`Code.gs`)** — Google Apps Script. Handles two actions via `doPost(e)`:
   - `action: "parse"` → proxies to Gemini API (key stored in Script Properties as `GEMINI_API_KEY`) and returns structured JSON
   - `action: "submit"` → appends rows to `Timesheet_Submissions` tab, writes `"Pending"` to column M and the formula `=IF(K{row}="", F{row}, F{row}+K{row})` to column L

3. **Google Sheet** — Three tabs: `Timesheet_Submissions` (columns A–M, see data contract below), `Staff_Directory`, `Dashboard`.

## Data Contract

Any change to column order, JSON field names, or the `action` values must be updated across **all three layers simultaneously**.

### Google Sheet columns A–M
```
A: Submission Timestamp   B: Staff Name         C: Phone Number
D: Date of Work           E: Work Venue         F: Basic Rate ($)
G: Start Time             H: End Time           I: Notes
J: Project No. (PM fills) K: OT Compensation (PM fills)
L: Final Rate — formula: =IF(K{row}="", F{row}, F{row}+K{row})
M: Status — always "Pending" on submission
```

### Frontend → Backend JSON (parse)
```json
{ "action": "parse", "staffName": "...", "phoneNumber": "...", "rawText": "..." }
```

### Backend → Frontend JSON (parse response)
```json
{ "status": "success", "entries": [{ "dateOfWork": "YYYY-MM-DD", "workVenue": "...", "basicRate": 0, "startTime": "HH:mm", "endTime": "HH:mm", "notes": "..." }] }
```

### Frontend → Backend JSON (submit)
```json
{ "action": "submit", "entries": [{ "staffName": "...", "phoneNumber": "...", "dateOfWork": "YYYY-MM-DD", "workVenue": "...", "basicRate": 0, "startTime": "HH:mm", "endTime": "HH:mm", "notes": "..." }] }
```

## Key Technical Notes

- **No build tools** — `index.html` is opened directly in a browser or hosted as-is on GitHub Pages.
- **CORS workaround** — the frontend sends `Content-Type: text/plain`; the backend returns JSON via `ContentService.createTextOutput().setMimeType(ContentService.MimeType.JSON)`.
- **API key security** — the Gemini API key must never appear in `index.html`. It lives only in Apps Script Script Properties.
- **Bilingual UI** — all buttons, labels, and messages in `index.html` must display both English and 繁體中文.
- **Mobile-first** — `index.html` uses `max-width: 480px`, buttons ≥48px tall, full-width inputs.
