# Job_Summary Tab — Design (2026-07-31)

## What we're building

A new Google Sheet tab, **`Job_Summary`**, showing labor cost per job (project),
sorted by project number. It is rebuilt automatically every time the PM clicks
**Timesheet ⏱ → Refresh Payroll 更新薪資表** — one click produces both the
Staff_Directory payroll AND the Job_Summary. No new menu item.

## Decisions (confirmed with Michael)

| Question | Decision |
|---|---|
| Rows included | Approved **and** Paid (a paid row is still a job cost); Pending/Rejected excluded. No paid/unpaid marking shown. |
| Month filter | None — Job_Summary always covers **all months**, even when payroll is filtered to one month. |
| Empty Project No. | Grouped in a final "(No Project No. 未填項目編號)" section, never hidden. |
| Layout | Calendar grid per project (approved via mockup). |

## Layout (per project section, sorted by project number ascending)

- Section header: `📋 Project <no> — Venue: <venue(s)>` (bold, merged row).
- Grid: staff down the side (grouped by canonical phone, display = names used),
  work dates across the top (sorted ascending, `yyyy-MM-dd`), each cell = sum of
  that person's Final Rate (column M) on that date.
- Right edge: per-staff Total. Bottom row: Day Total per date + project total in
  the corner. After all sections: `GRAND TOTAL (all jobs)` across every project.
- Styling mirrors Staff_Directory: blue title row, grey header rows, `$#,##0`
  number format, `autoResizeColumns` at the end. All labels bilingual EN + 繁體中文.

## Implementation shape

- New private function `_buildJobSummary(ss, data)` in `Code.gs`, called from
  `refreshPayroll()` after the Staff_Directory rebuild, reusing the same
  already-read `data` array (its own status filter, no month filter).
- `refreshPayroll()`'s completion alert mentions the Job_Summary was updated.
- Empty state: single message row "No approved submissions found." (bilingual).
- No changes to `index.html`, the A–P data contract, or the Notion sync.

## Docs updated in the same pass

- `sheet_setup_guide.md` — auto-created tabs list + "tabs the script builds" table.
- `apps_script_setup.md` — no tab list there; no change unless verification finds one.
- `TS_HR_Roster/CLAUDE.md` — Google Sheet tabs list in Architecture section.

## Done means

After one click of Refresh Payroll on a sheet with approved rows, the
Job_Summary tab exists and shows every project as a staff × date rate grid with
correct per-staff, per-day, per-project, and grand totals, sorted by project
number, with untagged rows grouped at the bottom.
