# Apps Script Setup Instructions
# Apps Script 設置指南

> Step-by-step guide to deploy the Google Apps Script backend for the Staff Timesheet System.

---

## Prerequisites
- A Google account
- The Google Sheet created following `sheet_setup_guide.md`
- (Optional, for Notion sync) a Notion internal integration secret with access to your Crew and Hiring Posts databases

---

## Step 1: Open Apps Script Editor

1. Open your **Staff Timesheet System** Google Sheet
2. Click **Extensions → Apps Script**
3. This opens the Apps Script editor in a new tab

---

## Step 2: Paste the Code

1. In the editor, you'll see a file called `Code.gs` with a default `myFunction()` stub
2. **Select all** the existing code and **delete** it
3. Open the `Code.gs` file provided and **copy the entire contents**
4. **Paste** it into the Apps Script editor
5. Click **💾 Save** (or Ctrl/Cmd+S)

---

## Step 3: Set the Notion API Key (optional)

Only needed if you use the Notion HR sync. Everything else works without it —
if the key is missing, the sync simply logs an error to `Sync_Log` and stops.

1. In the Apps Script editor, click the **⚙️ gear icon** (Project Settings) in the left sidebar
2. Scroll down to **Script Properties**
3. Click **Add script property**
4. Set:
   - **Property:** `NOTION_API_KEY`
   - **Value:** *(paste your Notion integration secret here)*
5. Click **Save script properties**

> ⚠️ The key is stored on Google's servers and never exposed to the frontend. Never put it in `index.html`.

---

## Step 4: Deploy as Web App

1. Click **Deploy → New deployment** (top-right)
2. Click the **⚙️ gear icon** next to "Select type" → choose **Web app**
3. Fill in:
   - **Description:** `Staff Timesheet API v1`
   - **Execute as:** `Me` (your account)
   - **Who has access:** `Anyone`
4. Click **Deploy**
5. You may be asked to authorize — click **Authorize access**, choose your Google account, and allow permissions
6. **Copy the Web app URL** that appears — you'll need this for the frontend

> The URL looks like: `https://script.google.com/macros/s/AKfyc...xxx/exec`

---

## Step 5: Test the Endpoint

### Health Check (GET)
Open the deployment URL in your browser. You should see:
> **Timesheet API is running. 工作紀錄系統運作中。**

### Submit Test (POST via curl)
Run this command in your terminal (replace `YOUR_DEPLOYMENT_URL`):

```bash
curl -L -X POST "YOUR_DEPLOYMENT_URL" \
  -H "Content-Type: text/plain" \
  -d '{"action":"submit","entries":[{"staffName":"Test User","phoneNumber":"9123 0000","dateOfWork":"2026-07-01","workVenue":"Test Venue","basicRate":500,"startTime":"09:00","endTime":"18:00","pic":"Michael","notes":"curl test"}]}'
```

Expected response:
```json
{"status":"success","rowsAdded":1}
```

Check your Google Sheet — a new row should appear in `Timesheet_Submissions`
with Status `Pending` (column N), the PIC in column K, and the Final Rate
formula in column M. You should also receive a notification email.

### Status Test (POST via curl)
```bash
curl -L -X POST "YOUR_DEPLOYMENT_URL" \
  -H "Content-Type: text/plain" \
  -d '{"action":"status","phoneNumber":"9123 0000"}'
```

Expected response:
```json
{"status":"success","submissions":[{"dateOfWork":"2026-07-01","workVenue":"Test Venue","basicRate":500,"startTime":"09:00","endTime":"18:00","status":"Pending"}]}
```

Afterwards, delete the test row from the Sheet.

---

## Updating the Deployment

If you make changes to `Code.gs`:
1. Paste the new code into the Apps Script editor and save
2. Click **Deploy → Manage deployments**
3. Click the **✏️ pencil icon** on your deployment
4. Under **Version**, select **New version**
5. Click **Deploy**

> ⚠️ You must create a new version for changes to take effect. The URL stays the same, so `index.html` does not need updating.

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "Sheet not found" error | Ensure the tab is named exactly `Timesheet_Submissions` |
| Notion sync does nothing | Check Script Properties → key name is exactly `NOTION_API_KEY`; then check the `Sync_Log` tab for the error |
| CORS error from browser | Ensure frontend sends `Content-Type: text/plain` (not `application/json`) |
| 403 error | Re-deploy with "Who has access: Anyone" |
| Changes not taking effect | You edited the code but didn't deploy a **New version** (see above) |
| No response | Check **Executions** log in the Apps Script editor for errors |
