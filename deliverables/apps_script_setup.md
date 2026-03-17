# Apps Script Setup Instructions
# Apps Script 設置指南

> Step-by-step guide to deploy the Google Apps Script backend for the Staff Timesheet System.

---

## Prerequisites
- A Google account
- The Google Sheet created following the Sheet Setup Guide
- A free Gemini API key from [Google AI Studio](https://aistudio.google.com/app/apikey)

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

## Step 3: Set the Gemini API Key

1. In the Apps Script editor, click the **⚙️ gear icon** (Project Settings) in the left sidebar
2. Scroll down to **Script Properties**
3. Click **Add script property**
4. Set:
   - **Property:** `GEMINI_API_KEY`
   - **Value:** *(paste your Gemini API key here)*
5. Click **Save script properties**

> ⚠️ The API key is stored securely in Google's servers and never exposed to the frontend.

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
  -d '{"action":"submit","entries":[{"staffName":"Test User","phoneNumber":"+852 0000 0000","dateOfWork":"2026-01-01","workVenue":"Test Venue","basicRate":500,"startTime":"09:00","endTime":"18:00","notes":"curl test"}]}'
```

Expected response:
```json
{"status":"success","rowsAdded":1}
```

Check your Google Sheet — a new row should appear in `Timesheet_Submissions`.

### AI Parse Test (POST via curl)
```bash
curl -L -X POST "YOUR_DEPLOYMENT_URL" \
  -H "Content-Type: text/plain" \
  -d '{"action":"parse","staffName":"Test","phoneNumber":"+852 0000 0000","rawText":"20/2 HKCEC 9am-6pm $600"}'
```

Expected response:
```json
{"status":"success","entries":[{"dateOfWork":"2026-02-20","workVenue":"HKCEC","basicRate":600,"startTime":"09:00","endTime":"18:00","notes":""}]}
```

---

## Updating the Deployment

If you make changes to `Code.gs`:
1. Click **Deploy → Manage deployments**
2. Click the **✏️ pencil icon** on your deployment
3. Under **Version**, select **New version**
4. Click **Deploy**

> ⚠️ You must create a new version for changes to take effect. The URL stays the same.

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "Sheet not found" error | Ensure the tab is named exactly `Timesheet_Submissions` |
| GEMINI_API_KEY error | Check Script Properties → ensure key name is exactly `GEMINI_API_KEY` |
| CORS error from browser | Ensure frontend sends `Content-Type: text/plain` (not `application/json`) |
| 403 error | Re-deploy with "Who has access: Anyone" |
| No response | Check Executions log in Apps Script editor for errors |
