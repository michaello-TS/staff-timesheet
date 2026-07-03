# Google Sheet Setup Guide — Staff Timesheet System
# 工作紀錄系統 — Google試算表設置指南

> **For the PM:** Follow these steps to create the Google Sheet that serves as the database for the staff timesheet system.
>
> You only need to build **one tab by hand**: `Timesheet_Submissions`. The script creates the rest (`Dashboard`, `Staff_Directory`, `Sync_Log`) automatically when you use the **Timesheet ⏱** menu.

---

## Step 1: Create a New Google Sheet

1. Go to [Google Sheets](https://sheets.google.com)
2. Click **Blank spreadsheet**
3. Rename it to: **Staff Timesheet System** (click the title in the top-left)

---

## Step 2: Set Up the `Timesheet_Submissions` Tab

### 2.1 Rename the Default Tab
- Right-click the tab at the bottom (labelled "Sheet1") → **Rename** → `Timesheet_Submissions`

### 2.2 Add Header Row (Row 1)
Type these headers exactly in order across columns A–P:

| Column | Header | Filled by |
|--------|--------|-----------|
| A | `Submission Timestamp` | Script (auto) |
| B | `Staff Name` | Staff (via web app) |
| C | `Phone Number` | Staff |
| D | `Date of Work` | Staff |
| E | `Work Venue` | Staff |
| F | `Basic Rate ($)` | Staff |
| G | `Start Time` | Staff |
| H | `End Time` | Staff |
| I | `Notes` | Staff |
| J | `Project No.` | PM (on approve, in Dashboard) |
| K | `PIC` | Staff picks; PM may override |
| L | `OT Compensation ($)` | PM (manually, if any) |
| M | `Final Rate ($)` | Formula (auto) |
| N | `Status` | Script writes "Pending"; PM approves/rejects |
| O | `Role` | PM (on approve, in Dashboard) |
| P | `Synced` | Script (auto, on Notion sync) |

> ⚠️ **CRITICAL:** This column order is a contract with the Apps Script backend and the web app. Do NOT change it, and never insert/delete columns without updating `Code.gs` at the same time.

### 2.3 Format the Header Row
1. Select Row 1 (click the row number "1" on the left)
2. **Format → Text → Bold**
3. **Format → Cell → Background colour** → Light grey (#F3F4F6)
4. **Format → Align → Centre**
5. **Freeze the header:** **View → Freeze → 1 row**

### 2.4 Column Formatting

#### Phone Number (Column C) — Plain Text
1. Select the entire column C (click the column header "C")
2. **Format → Number → Plain text**
   - This prevents Google Sheets from stripping leading `+` or zeros

#### Date of Work (Column D) — Date Format
1. Select column D
2. **Format → Number → Custom date and time** → `YYYY-MM-DD`

#### Currency Columns (F, L, M) — Currency Format
1. Select columns F, L, and M (hold Ctrl/Cmd while clicking column headers)
2. **Format → Number → Custom number format** → `$#,##0`

#### Time Columns (G, H) — Time Format
1. Select columns G and H
2. **Format → Number → Time** → `HH:mm` (24-hour format)

### 2.5 Final Rate Formula (Column M)
The Apps Script writes this formula automatically for every web submission:

```
=IF(L2="", F2, F2+L2)
```

Meaning:
- If OT Compensation (L) is empty → Final Rate = Basic Rate (F)
- If OT Compensation (L) has a value → Final Rate = Basic Rate (F) + OT Compensation (L)

> 💡 Only for rows you type in **manually**: copy this formula into column M yourself (adjusting the row number).

### 2.6 Data Validation on Status (Column N)
1. Select N2:N1000
2. **Data → Data validation → Add rule**
3. **Criteria:** Dropdown (from a list)
4. **Values:** `Pending, Approved, Rejected`
5. Check "Reject input" to prevent typos
6. Click **Done**

### 2.7 Conditional Formatting on Status (Column N)
Apply three rules to N2:N1000 (**Format → Conditional formatting**):

| Rule | Text is exactly | Background |
|------|-----------------|------------|
| 1 | `Pending` | Light yellow (#FEF9C3) |
| 2 | `Approved` | Light green (#DCFCE7) |
| 3 | `Rejected` | Light red (#FEE2E2) |

---

## Step 3: The Other Tabs (Automatic)

You do **not** need to create these — the script builds them:

| Tab | Created when | What it holds |
|-----|--------------|---------------|
| `Dashboard` | **Timesheet ⏱ → Show Pending** | Pending submissions with checkboxes + Project No. / PIC / Role dropdowns for approval |
| `Staff_Directory` | **Timesheet ⏱ → Refresh Payroll** | Per-person payroll summary (grouped by phone number) with totals |
| `Sync_Log` | First Notion sync | Timestamped log of every sync action, warning, and error |

---

## Step 4: Final Checks

- [ ] Tab named exactly `Timesheet_Submissions`
- [ ] Headers A–P in the exact order above, bold, frozen
- [ ] Column C formatted as plain text (phone numbers)
- [ ] Column D date format `YYYY-MM-DD`
- [ ] Columns F, L, M currency format `$#,##0`
- [ ] Columns G, H time format `HH:mm`
- [ ] Column N dropdown (Pending / Approved / Rejected) + conditional colours
- [ ] No merged cells in `Timesheet_Submissions`

Next: follow `apps_script_setup.md` to add the backend.
