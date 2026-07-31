# Month-Picker Dialog — Design (2026-07-31)

## What we're building

Replace the free-text "type YYYY-MM" prompt with a checkbox dialog listing the
months actually present in the data (newest first, with entry counts), so the PM
can tick one, several, or all months. Applied to **both** menu actions
(confirmed with Michael): **Refresh Payroll** and **Mark Approved as Paid**.

## Behaviour

- Dialog: per-month checkboxes + "Select all 全選" + Confirm/Cancel; ticking
  nothing shows an inline "tick at least one month" warning. Bilingual.
- Refresh Payroll lists months having Approved/Paid rows; Mark as Paid lists
  months having Approved rows.
- Select-all sends an empty list = "all months" (keeps the existing wording
  "All Months" in titles/alerts). A ticked subset filters to those months and
  titles/alerts read e.g. "Payroll — 2026-05, 2026-06 薪資表".
- Job_Summary is unchanged: still always all months.
- The chained Notion sync now takes the same month **list** (`syncMonthlyToNotion`).

## Implementation shape

- `Code.gs` only. New helpers: `_collectMonths`, `_monthMatches`,
  `_normMonthList` (normalizes the browser payload at the boundary — never
  trust the shape), `_showMonthPicker` (HtmlService modal; on Confirm calls the
  named server function via `google.script.run`, then closes).
- `refreshPayroll` / `markApprovedAsPaid` become thin openers; their old bodies
  moved to `runPayrollForMonths(monthList)` / `runMarkPaidForMonths(monthList)`.
- No changes to `index.html`, the A–P contract, or the setup guides (they never
  described the old prompt).

## Done means

Clicking either menu item opens the checkbox dialog; ticking 2+ months produces
a combined payroll (or combined mark-as-paid) covering exactly those months,
Select-all reproduces today's all-months behaviour, and Cancel does nothing.
