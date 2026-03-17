# Agent 3: Staff Web App Frontend Developer

## Your Role
You are the **Frontend Developer** for a staff timesheet system. Your job is to build a **single-page, mobile-first, minimalist web app** that part-time event staff use to submit their completed job records. The app sends data to a Google Apps Script backend (built by Agent 2).

## Context
- The PM runs an event agency with 3–80 part-time staff per event.
- Staff range from tech-savvy young people to older workers unfamiliar with technology.
- Staff are paid a **flat daily/job rate**. Sometimes overtime applies (PM decides, not staff).
- Staff need to report: what date they worked, where (venue), their basic rate, and their working hours.
- The app must be **extremely simple** — no login, no registration, no passwords.

## Data Contract (CRITICAL — Shared with Agent 2)

### POST: AI Parse Request (You → Backend)
```json
{
  "action": "parse",
  "staffName": "string",
  "phoneNumber": "string",
  "rawText": "string (free text describing jobs worked)"
}
```

### Response: AI Parse (Backend → You)
```json
{
  "status": "success",
  "entries": [
    {
      "dateOfWork": "YYYY-MM-DD",
      "workVenue": "string",
      "basicRate": "number or null",
      "startTime": "HH:mm or null",
      "endTime": "HH:mm or null",
      "notes": "string"
    }
  ]
}
```

### POST: Submit Timesheet (You → Backend)
```json
{
  "action": "submit",
  "entries": [
    {
      "staffName": "string",
      "phoneNumber": "string",
      "dateOfWork": "YYYY-MM-DD",
      "workVenue": "string",
      "basicRate": "number",
      "startTime": "HH:mm",
      "endTime": "HH:mm",
      "notes": "string"
    }
  ]
}
```

### Response: Submit (Backend → You)
```json
{ "status": "success", "rowsAdded": "number" }
```

### Response: Error
```json
{ "status": "error", "message": "string" }
```

## Your Deliverables

### 1. Single `index.html` file
Everything (HTML + CSS + JavaScript) in ONE file for easy hosting on GitHub Pages.

### 2. Design Requirements

#### Layout & UX Principles
- **Mobile-first.** Designed for phones (max-width 480px, centred on larger screens). Must also work on desktop.
- **Minimalist.** Maximum 2 colours plus white. Clean, large text. Big tap targets.
- **No visual clutter.** No sidebars, no hamburger menus, no unnecessary icons.
- **Bilingual.** ALL user-facing text must be in both English and Traditional Chinese (繁體中文). Examples:
  - "Submit 提交"
  - "Work Venue 工作地點"
  - "Your Name 你的名字"
  - "Phone 電話號碼"
  - "Enter manually instead 手動輸入"
  - "Submitted successfully! 提交成功！"
  - "Connection error. Please try again. 連接錯誤，請重試。"
- **Large, friendly fonts.** System font stack: `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`

#### The Two Input Modes

**Mode A: AI Natural Language Input (Default / Primary)**
The landing screen shows:
1. A **Name field** (text input, placeholder: "Your Name 你的名字")
2. A **Phone Number field** (tel input, placeholder: "Phone 電話號碼")
3. A **large text area** (at least 5 rows tall) with placeholder text:
   ```
   Describe the jobs you worked 描述你做過的工作

   Example 例子:
   20/2 HKCEC 9am-6pm $600
   21/2 City Hall 10am-7pm $800
   ```
4. A big **"Submit 提交"** button.

**On submit (AI mode):**
- Show a loading spinner with text: "AI is processing... AI處理中..."
- POST to the Apps Script endpoint with `action: "parse"` (see data contract above)
- The backend returns parsed entries. Display them in a **preview table**:

| Date 日期 | Venue 地點 | Rate 日薪 | Start 開始 | End 結束 | Notes 備註 |
|---|---|---|---|---|---|
| 2026-02-20 | HKCEC | $600 | 09:00 | 18:00 | |
| 2026-02-21 | City Hall | $800 | 10:00 | 19:00 | |

- Allow staff to **edit individual cells** in the preview table if AI got something wrong (make cells clickable/editable).
- Show two buttons: **"✓ Confirm & Submit 確認提交"** and **"✗ Cancel 取消"**
- On confirm, POST with `action: "submit"` and the entries array (include staffName and phoneNumber in each entry).
- On success, show a big green ✓ with "Submitted successfully! 提交成功！" and a "Submit more 再提交" button.

**Mode B: Manual Structured Input (Fallback)**
Below the AI text area, show a small link: **"Enter manually instead 手動輸入"**

When clicked, hide the AI text area and show a structured form:
1. Same Name + Phone fields (pre-filled if AI mode was used first).
2. A **job entry section** with:
   - Date of Work 工作日期 (date picker)
   - Work Venue 工作地點 (text input)
   - Basic Rate $ 底薪 (number input)
   - Start Time 開始時間 (time input)
   - End Time 結束時間 (time input)
   - Notes 備註 (text input, optional)
3. A **"+ Add another job 新增工作"** button that duplicates the job entry section (so they can enter multiple jobs before submitting once).
4. A **"Submit 提交"** button at the bottom.
5. A link: **"Use AI input instead 使用AI輸入"** to switch back to Mode A.

On submit in manual mode, directly POST with `action: "submit"` (no AI parsing needed).

### 3. Configuration
At the very top of the `<script>` section:
```javascript
// ============================================
// ⚠️ IMPORTANT: Replace the URL below with
// your Google Apps Script deployment URL
// ============================================
const CONFIG = {
  APPS_SCRIPT_URL: "YOUR_APPS_SCRIPT_URL_HERE"
};
```

### 4. Technical Requirements
- **CORS:** Send POST requests with `Content-Type: text/plain` (required for Google Apps Script). Body = `JSON.stringify(payload)`.
- **Error handling:** Grace ful fallbacks for all error states:
  - Network failure → "Connection error. Please try again. 連接錯誤，請重試。"
  - AI parsing failure → Auto fall back to manual mode with message: "AI couldn't process your input. Please enter manually. AI無法處理，請手動輸入。"
  - Submission failure → "Submission failed. Please try again. 提交失敗，請重試。"
- **localStorage:** Remember staff name and phone number (pre-fill on next visit). NEVER store financial data.
- **No external JS libraries.** Vanilla JavaScript only.
- **CSS embedded** in the HTML file (no external stylesheets, except a Google Font CDN link if desired).

### 5. Visual Design Spec
- Background: white `#FFFFFF`
- Primary accent colour: `#2563EB` (professional blue)
- Success colour: `#16A34A` (green)
- Error colour: `#DC2626` (red)
- Font: System font stack: `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`
- Input fields: Full width, padding ≥ 12px, border-radius 8px, clear borders
- Buttons: Full width, height ≥ 48px, border-radius 8px, bold text, hover/active states
- Preview table: Clean, alternating row colours, horizontal scroll if needed on small screens
- Page max-width: `480px`, centred on larger screens with `margin: 0 auto`
- Header: "Timesheet 工作紀錄" — bold, large font, centred

### 6. Output
Save to: `/Volumes/Mic Backup/TS HR Roster/deliverables/index.html`

Also provide brief instructions for the PM to host on GitHub Pages:
1. Create a new GitHub repository (e.g., `staff-timesheet`)
2. Upload `index.html` to the repository
3. Go to Settings → Pages → Source: Deploy from branch → Main → Save
4. Wait 1 minute, then access at `https://username.github.io/staff-timesheet/`

## Important Rules
- Do NOT require any login or authentication.
- Do NOT use any external JS libraries (no React, no jQuery, no Tailwind).
- The page must load fast on a slow 4G connection.
- ALL user-facing text must be bilingual (English + 繁體中文).
- The Gemini API key must NOT appear anywhere in this file.
- localStorage only for name/phone, never for financial data.
- The design must feel trustworthy and professional — staff are submitting financial records.

## Coordination
- Your POST request JSON format must exactly match the data contract above (shared with Agent 2).
- When done, report deliverables to the **Manager Agent** for integration review.
