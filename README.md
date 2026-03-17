# Staff Timesheet System — Setup Guide
# 工作紀錄系統 — 設置指南

> A zero-cost, automated timesheet system for event agency PMs to collect job records from part-time staff.

## What's Included

| File | Purpose |
|------|---------|
| `deliverables/sheet_setup_guide.md` | Step-by-step Google Sheet setup instructions |
| `deliverables/Code.gs` | Google Apps Script backend (paste into Apps Script editor) |
| `deliverables/apps_script_setup.md` | Apps Script deployment instructions |
| `deliverables/index.html` | Staff-facing web app (host on GitHub Pages) |

## Setup Steps (In Order)

### Step 1: Create the Google Sheet
Follow `deliverables/sheet_setup_guide.md` to create a Google Sheet with:
- **Timesheet_Submissions** tab (columns A–M)
- **Staff_Directory** tab (reference list)
- **Dashboard** tab (summary with formulas)

### Step 2: Add the Apps Script Backend
1. Open said Google Sheet → **Extensions → Apps Script**
2. Delete any existing code → paste the contents of `deliverables/Code.gs`
3. Save (Ctrl/Cmd+S)

### Step 3: Set the Gemini API Key
1. In Apps Script editor → **⚙️ Project Settings → Script Properties**
2. Add property: `GEMINI_API_KEY` = *(your Gemini API key)*
3. Get a free key at [Google AI Studio](https://aistudio.google.com/app/apikey)

### Step 4: Deploy as Web App
1. **Deploy → New deployment → Web app**
2. Execute as: **Me** · Who has access: **Anyone**
3. Click **Deploy** → authorise when prompted
4. **Copy the deployment URL** (looks like `https://script.google.com/macros/s/...`)

### Step 5: Configure the Web App
1. Open `deliverables/index.html` in a text editor
2. Find this line near the top:
   ```js
   APPS_SCRIPT_URL: "YOUR_APPS_SCRIPT_URL_HERE"
   ```
3. Replace `YOUR_APPS_SCRIPT_URL_HERE` with your deployment URL from Step 4

### Step 6: Host on GitHub Pages
1. Create a new GitHub repository (e.g. `staff-timesheet`)
2. Upload `index.html` to the repository
3. **Settings → Pages → Source: Deploy from branch → Main → Save**
4. Wait ~1 minute, then access at `https://username.github.io/staff-timesheet/`

### Step 7: Share with Staff
Send the GitHub Pages URL to staff via WhatsApp. They open it on their phone, type in their work details, and submit.

---

## Integration Test (End-to-End)

1. Open the GitHub Pages URL on your phone
2. Enter name: `Test User`, phone: `+852 0000 0000`
3. In the text area, type: `20/2 HKCEC 9am-6pm $600`
4. Tap **Submit 提交**
5. Wait for AI to parse → review the preview table → tap **✓ Confirm 確認提交**
6. Check your Google Sheet — a new row should appear in `Timesheet_Submissions`
7. Verify: Timestamp (col A), Staff Name (col B), Final Rate formula (col L), Status = "Pending" (col M)

---

## Known Limitations

- **No authentication** — anyone with the URL can submit (by design, for simplicity)
- **Gemini AI parsing** depends on free-tier API availability and may occasionally misparse
- **Google Apps Script** has a ~6-minute execution timeout and ~30 seconds typical for auto-redirects
- **No edit/delete** by staff after submission — PM manages all corrections in the Sheet
- **Data validation** — the web app validates required fields but does not prevent duplicate submissions
