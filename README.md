# Staff Timesheet System — Setup Guide
# 工作紀錄系統 — 設置指南

> A zero-cost, automated timesheet system for event agency PMs to collect job records from part-time staff.

## How It Works

1. **Staff** open a mobile web page (GitHub Pages), enter an access code, and fill in structured job entries (date, venue, rate, start/end time, PIC, notes). They can also check the status of past submissions by phone number.
2. **Google Apps Script** receives the submission and appends rows to the `Timesheet_Submissions` tab of a Google Sheet, then emails the PM.
3. **The PM** reviews via a custom menu in the Sheet (**Timesheet ⏱ → Show Pending**), fills in Project No. / PIC / Role, and approves or rejects. Duplicate submissions (same phone + date) are auto-flagged in Notes and in the notification email.
4. **Refresh Payroll** builds the `Staff_Directory` tab: an FPS Payment List (one row per person) plus per-person job detail, then offers to sync approved rows one-way into the Notion HR databases (Crew DB + Hiring Posts).
5. **Accounting** pays staff from the FPS list, then clicks **Mark Approved as Paid** — statuses flip to `Paid` in one click and drop out of the next payroll run.

## What's Included

| File | Purpose |
|------|---------|
| `deliverables/sheet_setup_guide.md` | Step-by-step Google Sheet setup instructions |
| `deliverables/Code.gs` | Google Apps Script backend (paste into Apps Script editor) |
| `deliverables/apps_script_setup.md` | Apps Script deployment instructions |
| `deliverables/index.html` | Staff-facing web app (host on GitHub Pages) |
| `index.html` (repo root) | The copy GitHub Pages actually serves — **must stay identical to `deliverables/index.html`** |

## Setup Steps (In Order)

### Step 1: Create the Google Sheet
Follow `deliverables/sheet_setup_guide.md` to create a Google Sheet with the
**Timesheet_Submissions** tab (columns A–P). The other tabs — `Dashboard`,
`Staff_Directory`, `Sync_Log` — are created automatically by the script when
you use the Timesheet ⏱ menu.

### Step 2: Add the Apps Script Backend
1. Open the Google Sheet → **Extensions → Apps Script**
2. Delete any existing code → paste the contents of `deliverables/Code.gs`
3. Save (Ctrl/Cmd+S)

### Step 3: Set the Notion API Key (optional — only for Notion sync)
1. In Apps Script editor → **⚙️ Project Settings → Script Properties**
2. Add property: `NOTION_API_KEY` = *(your Notion integration secret)*
3. Skip this if you don't use the Notion sync — everything else works without it.

### Step 4: Deploy as Web App
1. **Deploy → New deployment → Web app**
2. Execute as: **Me** · Who has access: **Anyone**
3. Click **Deploy** → authorise when prompted
4. **Copy the deployment URL** (looks like `https://script.google.com/macros/s/...`)

See `deliverables/apps_script_setup.md` for details and testing.

### Step 5: Configure the Web App
1. Open `index.html` in a text editor
2. Find the `CONFIG` block near the top of the `<script>` section:
   ```js
   const CONFIG = {
     APPS_SCRIPT_URL: "...",   // ← your deployment URL from Step 4
     ACCESS_CODE: "..."        // ← the code staff must type to open the form
   };
   ```
3. Update both values, in **both** copies (`index.html` and `deliverables/index.html`)

### Step 6: Host on GitHub Pages
1. Push `index.html` to this repository's `main` branch
2. **Settings → Pages → Source: Deploy from branch → Main → Save**
3. Wait ~1 minute, then access at `https://<username>.github.io/staff-timesheet/`

### Step 7: Share with Staff
Send the GitHub Pages URL + the access code to staff via WhatsApp. They open it
on their phone, enter the code, fill in their job details, and submit.

---

## PM Workflow (Day-to-Day)

1. Get email: "New timesheet from …" (entries flagged ⚠️ POSSIBLE DUPLICATE mean the same phone + date was already submitted — check before approving)
2. Open the Google Sheet → **Timesheet ⏱ → Show Pending 顯示待審批**
3. In the Dashboard: fill **Project No.**, confirm/override **PIC**, pick **Role**, tick the checkbox
4. **Timesheet ⏱ → ✓ Approve Checked** (or ✕ Reject Checked)
   - ⚠️ Don't sort or delete rows in `Timesheet_Submissions` while the Dashboard is open. If you do, re-run Show Pending — stale rows are detected and skipped automatically.
5. End of month: **Timesheet ⏱ → Refresh Payroll 更新薪資表** → enter the month → optionally sync to Notion when prompted

## Accounting Workflow (Monthly Payment)

1. Open `Staff_Directory` — the **💰 FPS Payment List** at the top has one row per person: name, FPS phone number, and total to pay
2. Pay each person via FPS, straight down the list
3. **Timesheet ⏱ → 💰 Mark Approved as Paid 標記已支付** → enter the month → confirm
   - All that month's Approved rows flip to **Paid** in one click
   - Paid rows drop out of the next Refresh Payroll, so the payroll sheet always shows only what's still owed
   - Staff see 💰 Paid 已支付 when they check their status in the web app

---

## Integration Test (End-to-End)

1. Open the GitHub Pages URL on your phone and enter the access code
2. Enter name: `Test User`, phone: `9123 0000`
3. Fill one job entry: today's date, venue `HKCEC`, rate `600`, time `09:00`–`18:00`, PIC `Michael`
4. Tap **Submit 提交**
5. Check the Google Sheet — a new row appears in `Timesheet_Submissions` with Status `Pending` (col N) and the Final Rate formula in col M
6. Check your email for the PM notification
7. In the web app, tap **Check my submission status** with the same phone number — the entry should show as ⏳ Pending

---

## Known Limitations

- **Access code is not real security** — it's stored in the page source (and this public repo), and the Apps Script URL accepts direct requests. It keeps out casual visitors only. Don't put sensitive data in this system.
- **Status lookup is by phone number** — anyone who knows a colleague's number can see their submissions (dates, venues, rates).
- **No edit/delete by staff** after submission — the PM manages corrections in the Sheet.
- **Dashboard approvals reference row numbers** — a mismatch guard skips rows that moved, but re-running Show Pending after any manual sheet edit is the safe habit.
- **Rows synced to Notion are stamped in column P and never re-synced.** If a row was skipped because its Hiring Post didn't exist yet, create the post, clear that row's column P, and sync again.
- **Google Apps Script quotas** — ~6-minute execution limit and daily email limits on free accounts; fine at small-team scale.
