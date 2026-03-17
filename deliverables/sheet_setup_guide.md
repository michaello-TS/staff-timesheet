# Google Sheet Setup Guide — Staff Timesheet System
# 工作紀錄系統 — Google試算表設置指南

> **For the PM:** Follow these step-by-step instructions to create the Google Sheet that serves as the database for the staff timesheet system.

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
Type these headers exactly in order across columns A–M:

| Column | Header | Width |
|--------|--------|-------|
| A | `Submission Timestamp` | 180px |
| B | `Staff Name` | 150px |
| C | `Phone Number` | 150px |
| D | `Date of Work` | 130px |
| E | `Work Venue` | 180px |
| F | `Basic Rate ($)` | 120px |
| G | `Start Time` | 100px |
| H | `End Time` | 100px |
| I | `Notes` | 200px |
| J | `Project No.` | 120px |
| K | `OT Compensation ($)` | 160px |
| L | `Final Rate ($)` | 120px |
| M | `Status` | 100px |

> ⚠️ **CRITICAL:** This column order is a contract with the Apps Script backend. Do NOT change the order.

### 2.3 Format the Header Row
1. Select Row 1 (click the row number "1" on the left)
2. **Format → Text → Bold**
3. **Format → Cell → Background colour** → Light grey (#F3F4F6)
4. **Format → Align → Centre**
5. **Font:** Select all cells → **Format → Font → Arial** (apply to the entire sheet)
6. **Freeze the header:** Go to **View → Freeze → 1 row**

### 2.4 Column Formatting

#### Phone Number (Column C) — Format as Plain Text
1. Select the entire column C (click the column header "C")
2. **Format → Number → Plain text**
   - This prevents Google Sheets from stripping leading `+` or zeros

#### Date of Work (Column D) — Date Format
1. Select column D
2. **Format → Number → Custom date and time** → `YYYY-MM-DD`

#### Currency Columns (F, K, L) — Currency Format
1. Select columns F, K, and L (hold Ctrl/Cmd while clicking column headers)
2. **Format → Number → Custom number format** → `$#,##0`

#### Time Columns (G, H) — Time Format
1. Select columns G and H
2. **Format → Number → Time** → `HH:mm` (24-hour format)

### 2.5 Final Rate Formula (Column L)
For each data row, column L should contain this formula. Enter in L2:

```
=IF(K2="", F2, F2+K2)
```

This means:
- If OT Compensation (K) is empty → Final Rate = Basic Rate (F)
- If OT Compensation (K) has a value → Final Rate = Basic Rate (F) + OT Compensation (K)

> 💡 The Apps Script will automatically write this formula for every new submission. For manual entries, copy this formula down.

### 2.6 Data Validation on Status (Column M)
1. Select column M (from M2 downwards, e.g., M2:M1000)
2. **Data → Data validation → Add rule**
3. **Criteria:** Dropdown (from a list)
4. **Values:** `Pending, Approved, Paid`
5. Check "Reject input" to prevent invalid values
6. Click **Done**

### 2.7 Conditional Formatting on Status (Column M)
Apply three rules to M2:M1000:

**Rule 1: Pending → Light Yellow**
1. Select M2:M1000
2. **Format → Conditional formatting**
3. Format rules: **Text is exactly** → `Pending`
4. Formatting style: Background colour → **Light yellow** (#FEF9C3)
5. Click **Done**

**Rule 2: Approved → Light Blue**
1. **Add another rule**
2. Format rules: **Text is exactly** → `Approved`
3. Formatting style: Background colour → **Light blue** (#DBEAFE)
4. Click **Done**

**Rule 3: Paid → Light Green**
1. **Add another rule**
2. Format rules: **Text is exactly** → `Paid`
3. Formatting style: Background colour → **Light green** (#DCFCE7)
4. Click **Done**

### 2.8 Add 3 Sample Data Rows

Enter the following test data:

**Row 2:**
| A | B | C | D | E | F | G | H | I | J | K | L | M |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 2026-02-20 10:00 | Alice Chen | +852 1234 5678 | 2026-02-20 | HKCEC Hall 3 | 600 | 09:00 | 18:00 | | | | `=IF(K2="", F2, F2+K2)` | Pending |

**Row 3:**
| A | B | C | D | E | F | G | H | I | J | K | L | M |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 2026-02-20 10:15 | Bob Smith | +852 9876 5432 | 2026-02-20 | HKCEC Hall 3 | 600 | 09:00 | 22:00 | Stayed for OT till 10pm | | | `=IF(K3="", F3, F3+K3)` | Pending |

**Row 4:**
| A | B | C | D | E | F | G | H | I | J | K | L | M |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 2026-02-20 11:00 | Alice Chen | +852 1234 5678 | 2026-02-21 | City Hall | 800 | 10:00 | 19:00 | | P2026-003 | 200 | `=IF(K4="", F4, F4+K4)` | Approved |

> After entry, Row 2 and 3 should show `$600` in Final Rate (L), and Row 4 should show `$1,000`.

---

## Step 3: Create the `Staff_Directory` Tab

1. Click the **+** button at the bottom to add a new tab
2. Rename it to `Staff_Directory`
3. Add these headers in Row 1:

| Column | Header |
|--------|--------|
| A | `Staff Name` |
| B | `Phone Number` |
| C | `Usual Roles` |
| D | `Notes` |

4. Format Row 1: Bold, light grey background, Arial font
5. Freeze Row 1
6. Format column B as **Plain text** (to preserve phone number formatting)
7. Adjust column widths for readability

> This tab is a reference list for the PM. It is not connected to the automation.

---

## Step 4: Create the `Dashboard` Tab

1. Click **+** to add another tab → rename to `Dashboard`
2. Set up the following summary cells:

| Cell | Label | Cell | Formula |
|------|-------|------|---------|
| A1 | **Dashboard — Staff Timesheet Summary** | | (merge A1:D1, bold, 16pt) |
| A3 | **Pending Submissions** | B3 | `=COUNTIF(Timesheet_Submissions!M:M, "Pending")` |
| A4 | **Approved (Unpaid)** | B4 | `=COUNTIF(Timesheet_Submissions!M:M, "Approved")` |
| A5 | **Paid** | B5 | `=COUNTIF(Timesheet_Submissions!M:M, "Paid")` |
| A7 | **Total Payroll (Approved)** | B7 | `=SUMIF(Timesheet_Submissions!M:M, "Approved", Timesheet_Submissions!L:L)` |
| A8 | **Total Payroll (Paid)** | B8 | `=SUMIF(Timesheet_Submissions!M:M, "Paid", Timesheet_Submissions!L:L)` |

3. Format:
   - Column A labels: Bold, Arial
   - Column B values: `$#,##0` for payroll rows, plain number for count rows
   - A1 title: Bold, 16pt, merge across A1:D1
   - Add light background colours to distinguish sections

> With the sample data, you should see: Pending = 2, Approved = 1, Paid = 0, Total Payroll (Approved) = $1,000

---

## Step 5: Final Checks

- [ ] **Font:** Arial everywhere
- [ ] **Header row:** Bold, light grey, frozen in all tabs
- [ ] **Column C:** Formatted as plain text (phone numbers)
- [ ] **Column D:** Date format YYYY-MM-DD
- [ ] **Columns F, K, L:** Currency format `$#,##0`
- [ ] **Column L:** Contains `=IF(K{row}="", F{row}, F{row}+K{row})` formula
- [ ] **Column M:** Data validation dropdown (Pending / Approved / Paid)
- [ ] **Column M:** Conditional formatting (yellow/blue/green)
- [ ] **Dashboard formulas:** Show correct counts and totals
- [ ] **No merged cells** in `Timesheet_Submissions` (only Dashboard title is merged)
- [ ] **Column widths:** Readable without horizontal scrolling

---

## Summary of All Formulas

| Location | Formula |
|----------|---------|
| `Timesheet_Submissions!L{row}` | `=IF(K{row}="", F{row}, F{row}+K{row})` |
| `Dashboard!B3` | `=COUNTIF(Timesheet_Submissions!M:M, "Pending")` |
| `Dashboard!B4` | `=COUNTIF(Timesheet_Submissions!M:M, "Approved")` |
| `Dashboard!B5` | `=COUNTIF(Timesheet_Submissions!M:M, "Paid")` |
| `Dashboard!B7` | `=SUMIF(Timesheet_Submissions!M:M, "Approved", Timesheet_Submissions!L:L)` |
| `Dashboard!B8` | `=SUMIF(Timesheet_Submissions!M:M, "Paid", Timesheet_Submissions!L:L)` |
