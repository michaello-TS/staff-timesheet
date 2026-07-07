# Timesheet Upgrade Batch — Implementation Plan (2026-07-07)

> **For the implementing agent:** Execute tasks strictly in order, one at a time. Verify each task with its listed check before moving on. **Do NOT run `git commit` — the reviewer commits after two review passes.** Work only in the working tree.

**Goal:** Fix 6 bugs (one money-affecting) and ship 8 UX upgrades to the staff timesheet app, keeping all three layers (index.html / Code.gs / Google Sheet contract) and the setup docs in sync.

**Architecture:** No column changes — the A–P sheet contract is untouched. The **JSON contract changes**: `submit` and `status` payloads gain an `accessCode` field, and the `submit` response gains a `duplicates` array. Phone numbers get one canonical form (digits only, no spaces/dashes) applied at every boundary. The frontend gains a confirm-before-submit screen, inline field errors, draft autosave, and a success recap.

**Tech stack:** Plain HTML/CSS/JS (no build step), Google Apps Script. No test framework exists — each task has a manual verification step instead (node snippets for pure logic, grep/diff for wiring).

**Files in scope:**
- `deliverables/index.html` (edit here first; root `index.html` is a byte-identical copy, synced in Task 11)
- `deliverables/Code.gs`
- `deliverables/apps_script_setup.md`, `deliverables/sheet_setup_guide.md`
- `CLAUDE.md` (project one — data-contract section)

**INVARIANTS (from CLAUDE.md — never break):**
- Column order A–P unchanged everywhere.
- Every user-facing string bilingual (English + 繁體中文).
- Mobile-first: buttons ≥48px tall, max-width 480px.
- No API keys in index.html. (`ACCESS_CODE` in index.html is accepted — it is a gate code, not an API key; the server-side copy lives in Script Properties.)
- PIC options in index.html must equal the Dashboard `picOptions` list in Code.gs (unchanged by this batch — verify at the end anyway).

**Phone-pattern audit (per bug-fix guideline — every place phone is read/compared):**
| Location | Today | After this plan |
|---|---|---|
| `index.html` collectEntries | as typed | normalized (digits only) + validated 8-digit |
| `Code.gs` handleSubmit append (col C) | as typed | normalized |
| `Code.gs` handleSubmit dup detection | strips spaces | uses shared `_normPhone` |
| `Code.gs` handleStatus compare | strips spaces | uses shared `_normPhone` (both sides) |
| `Code.gs` refreshPayroll grouping | **raw — BUG** | grouped by `_normPhone` |
| `Code.gs` syncMonthlyToNotion / findCrewByPhone | **raw — BUG** | normalized + legacy "XXXX XXXX" fallback query |

---

## Task 1 — Frontend foundations: helpers + CSS

**Files:** Modify `deliverables/index.html`

**1a.** In the `<script>`, directly under the `const $ = (id) => ...` line, add:

```js
// ---- Shared helpers ----
function normalizePhone(p) {
  return String(p || "").replace(/[\s\-]/g, "");
}
function isValidHKPhone(p) {
  // 8 digits, HK mobile ranges (FPS is tied to the mobile number)
  return /^[4-9]\d{7}$/.test(normalizePhone(p));
}
function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
function todayStr() {
  var d = new Date();
  return d.getFullYear() + "-" +
    String(d.getMonth() + 1).padStart(2, "0") + "-" +
    String(d.getDate()).padStart(2, "0");
}
```

**1b.** In the `<style>` block, after the `.alert-error` rule, add:

```css
/* ========== INLINE FIELD ERRORS ========== */
.input-error {
  border-color: var(--error) !important;
  box-shadow: 0 0 0 3px rgba(220, 38, 38, 0.10) !important;
}

.field-error-msg {
  color: var(--error);
  font-size: 0.78rem;
  font-weight: 600;
  margin-top: 4px;
}

.field-warn-msg {
  color: #92400E;
  background: #FEF3C7;
  border-radius: 6px;
  padding: 6px 10px;
  font-size: 0.78rem;
  font-weight: 600;
  margin-top: 6px;
}

/* ========== SUBMIT SPINNER ========== */
.spinner {
  display: inline-block;
  width: 18px;
  height: 18px;
  border: 2.5px solid rgba(255, 255, 255, 0.35);
  border-top-color: var(--white);
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
  margin-right: 8px;
  flex-shrink: 0;
}

@keyframes spin { to { transform: rotate(360deg); } }

/* ========== CONFIRM SCREEN ========== */
.confirm-identity {
  background: var(--primary-light);
  border: 1.5px solid var(--primary);
  border-radius: var(--radius);
  padding: 14px 16px;
  margin-bottom: 16px;
  font-size: 0.95rem;
}

.confirm-identity .confirm-name {
  font-weight: 800;
  font-size: 1.1rem;
}

.confirm-job {
  border: 1.5px solid var(--gray-200);
  border-radius: var(--radius);
  padding: 12px 14px;
  margin-bottom: 10px;
  font-size: 0.9rem;
}

.confirm-job .confirm-job-line1 { font-weight: 700; }
.confirm-job .confirm-job-line2 { color: var(--gray-500); font-size: 0.85rem; }

.confirm-total {
  display: flex;
  justify-content: space-between;
  font-size: 1.05rem;
  font-weight: 800;
  padding: 12px 4px;
  border-top: 2px solid var(--gray-900);
  margin-top: 12px;
}

.overnight-tag {
  display: inline-block;
  background: #FEF3C7;
  color: #92400E;
  font-size: 0.72rem;
  font-weight: 700;
  border-radius: 10px;
  padding: 2px 8px;
  margin-left: 6px;
  vertical-align: middle;
}
```

**Verify:** `node -e` the three pure functions:
```bash
node -e '
function normalizePhone(p){return String(p||"").replace(/[\s\-]/g,"")}
function isValidHKPhone(p){return /^[4-9]\d{7}$/.test(normalizePhone(p))}
function escapeHtml(s){return String(s==null?"":s).replace(/[&<>"'"'"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'"'"'":"&#39;"}[c]})}
console.log(normalizePhone("9123 4567")==="91234567");
console.log(isValidHKPhone("9123 4567")===true, isValidHKPhone("2123 4567")===false, isValidHKPhone("912345")===false, isValidHKPhone("9123456789")===false);
console.log(escapeHtml("<img src=x>")==="&lt;img src=x&gt;");
'
```
Expected: all `true`.

---

## Task 2 — Backend: access-code gate, server validation, phone canonicalization, duplicates in response

**Files:** Modify `deliverables/Code.gs`

**2a.** Under the `var TIMEZONE` line add:

```js
// Canonical phone form used EVERYWHERE (dup check, status, payroll, Notion sync)
function _normPhone(p) {
  return String(p || "").replace(/[\s\-]/g, "");
}

// Server-side copy of the access code. Set Script Property ACCESS_CODE to the
// same value as CONFIG.ACCESS_CODE in index.html. If the property is missing,
// the check is skipped (so an un-configured deployment keeps working).
function _checkAccessCode(payload) {
  var expected = PropertiesService.getScriptProperties().getProperty("ACCESS_CODE");
  if (!expected) return true;
  return String(payload.accessCode || "") === expected;
}
```

**2b.** In `doPost`, after `var action = payload.action;`, add:

```js
    if (!_checkAccessCode(payload)) {
      return _jsonResponse({ status: "error", message: "Invalid access code. 存取碼不正確。" });
    }
```

**2c.** In `handleSubmit`, after the `if (!entries || !entries.length)` guard, add server-side entry validation (anti-bot / anti-garbage — the public URL accepts POSTs from anyone):

```js
  // Server-side sanity check — the endpoint is public, never trust the payload
  for (var v = 0; v < entries.length; v++) {
    var en = entries[v];
    var okEntry = en &&
      String(en.staffName || "").trim() &&
      /^[4-9]\d{7}$/.test(_normPhone(en.phoneNumber)) &&
      /^\d{4}-\d{2}-\d{2}$/.test(String(en.dateOfWork || "")) &&
      String(en.workVenue || "").trim() &&
      parseFloat(en.basicRate) > 0 &&
      String(en.startTime || "") &&
      String(en.endTime || "");
    if (!okEntry) {
      return { status: "error", message: "Invalid data in entry " + (v + 1) + "." };
    }
  }
```

**2d.** Still in `handleSubmit`:
- Replace the two existing inline space-strips with `_normPhone`:
  - dup-lookup build: `var prevPhone = _normPhone(prev[k][0]);`
  - dup key: `var dupKey = _normPhone(entry.phoneNumber) + "|" + String(entry.dateOfWork || "").trim();`
- **Write the canonical phone to the sheet**: in the `appendRow` array change the C-column element from `entry.phoneNumber` to `_normPhone(entry.phoneNumber)`.
- Track duplicate indexes for the response. Before the entries loop add `var dupIndexes = [];`; inside the `if (existingPairs[dupKey])` branch add `dupIndexes.push(i + 1);`.
- Change the return to: `return { status: "success", rowsAdded: rowsAdded, duplicates: dupIndexes };`

**2e.** In `handleStatus`, replace the compare line with:

```js
    if (_normPhone(data[i][2]) === _normPhone(phone)) {
```
(delete the now-redundant `.replace(/\s/g,"")` calls).

**Verify:**
```bash
grep -n "_normPhone" deliverables/Code.gs
```
Expected: definition + uses in handleSubmit (3×: dup lookup, dup key, appendRow) + handleStatus. Also `grep -n "duplicates" deliverables/Code.gs` shows the new return.

---

## Task 3 — Backend: payroll includes Paid rows + groups by canonical phone

**Files:** Modify `deliverables/Code.gs` (`refreshPayroll`)

Rules:
1. Filter change: include rows whose Status is `"Approved"` **or** `"Paid"` (today only Approved — a paid month's report can never be regenerated).
2. Group by `_normPhone(data[i][2])` instead of raw phone (fixes the split-person money bug). Display the normalized phone.
3. Each job records its status: add `paid: (status === "Paid")` to the pushed job object.
4. Track per-person `toPay` (sum of non-paid jobs) alongside `total`.
5. **FPS Payment List gains a 5th column `Status 狀態`** per person:
   - all jobs paid → `"✓ PAID 已支付"`
   - no jobs paid → `"TO PAY 待支付"`
   - mixed → `"PARTIAL 部分已支付"`
   Header array becomes `["Staff Name 姓名", "Phone (FPS) 電話", "Jobs 工作數", "Total 總額 ($)", "Status 狀態"]`.
6. Per-person detail table gains a 5th column `Status`: `"✓ Paid 已支付"` for paid jobs, `""` otherwise. Header array: `["Project No.", "Date", "Work Venue", "Final Rate ($)", "Status"]`.
7. All `mergeAcross()` ranges and background bands in this function widen from 4 to 5 columns (`dir.getRange(row, 1, 1, 5)`), and the final autofit becomes `dir.autoResizeColumns(1, 5);`.
8. Summary rows at the bottom (replace the single GRAND TOTAL block):

```js
  if (phoneOrder.length > 0) {
    var toPayTotal = 0;
    for (var g = 0; g < phoneOrder.length; g++) toPayTotal += staffMap[phoneOrder[g]].toPay;

    dir.getRange(row, 3).setValue("TO PAY TOTAL 待支付總計");
    dir.getRange(row, 3).setTextStyle(grandFont).setHorizontalAlignment("right");
    dir.getRange(row, 4).setValue(toPayTotal).setNumberFormat("$#,##0").setTextStyle(grandFont);
    dir.getRange(row, 3, 1, 2).setBackground("#D1FAE5");
    row++;

    dir.getRange(row, 3).setValue("GRAND TOTAL (incl. paid) 總計（含已支付）");
    dir.getRange(row, 3).setTextStyle(grandFont).setHorizontalAlignment("right");
    dir.getRange(row, 4).setValue(grandTotal).setNumberFormat("$#,##0").setTextStyle(grandFont);
    dir.getRange(row, 3, 1, 2).setBackground("#C6DAFC");
  } else { /* keep existing empty-state message, but change the text to
              "No approved or paid submissions found..." bilingual */ }
```

9. The closing `ui.alert` reports the breakdown, e.g. `phoneOrder.length + " staff. To pay: $" + toPayTotal + " · Already paid: $" + (grandTotal - toPayTotal)` (keep bilingual).
10. The FPS section banner text stays, but append `— rows marked TO PAY only 只支付標記TO PAY的行`.

**Verify:** `grep -n '"Paid"' deliverables/Code.gs` shows the widened filter in refreshPayroll; `grep -n "autoResizeColumns" deliverables/Code.gs` shows `(1, 5)`.

---

## Task 4 — Backend: Notion sync uses canonical phone (+ legacy fallback)

**Files:** Modify `deliverables/Code.gs`

**4a.** In `syncMonthlyToNotion`, change `var phone = String(data[i][1+1]).trim();` line (`data[i][2]`) to `var phone = _normPhone(data[i][2]);`.

**4b.** In `findCrewByPhone`, add a legacy fallback — older Crew pages may store the phone as `"9123 4567"`:

```js
function findCrewByPhone(phone) {
  var result = queryNotionDB(CREW_DB_ID, {
    filter: { property: "Phone 電話", phone_number: { equals: phone } }
  });

  // Legacy fallback: older Crew entries may have the phone stored as "XXXX XXXX"
  if ((!result.results || result.results.length === 0) && /^\d{8}$/.test(phone)) {
    result = queryNotionDB(CREW_DB_ID, {
      filter: { property: "Phone 電話", phone_number: { equals: phone.slice(0, 4) + " " + phone.slice(4) } }
    });
  }

  if (!result.results || result.results.length === 0) {
    return { found: false };
  }
  // ... rest unchanged
```

`createCrewEntry` is called with the already-normalized phone — no change needed there.

**Verify:** `grep -n "slice(0, 4)" deliverables/Code.gs` → 1 hit inside findCrewByPhone.

---

## Task 5 — Backend: kill ghost checkboxes on Dashboard rebuild

**Files:** Modify `deliverables/Code.gs` (`showPendingDashboard`)

After `dash.clear(); dash.clearConditionalFormatRules();` add:

```js
  // clear() leaves checkbox data-validations behind — wipe them so a shorter
  // list doesn't show ghost checkboxes from the previous run
  dash.getRange(1, 1, dash.getMaxRows(), dash.getMaxColumns()).clearDataValidations();
```

**Verify:** `grep -n "clearDataValidations" deliverables/Code.gs` → 1 hit right after the clear calls.

---

## Task 6 — Frontend: field-level validation + date/overnight guards + numeric keypad

**Files:** Modify `deliverables/index.html`

**6a.** In `createJobEntry()`:
- Date input gets a max: `'<input type="date" id="date_' + idx + '" max="' + todayStr() + '" required>'`
- Rate input gets the numeric keypad: add `inputmode="numeric"` to the rate `<input>`.

**6b.** Add error helpers near the validation code:

```js
function clearFieldErrors() {
  document.querySelectorAll(".field-error-msg, .field-warn-msg").forEach(function (el) { el.remove(); });
  document.querySelectorAll(".input-error").forEach(function (el) { el.classList.remove("input-error"); });
}

function markError(input, msg) {
  input.classList.add("input-error");
  var div = document.createElement("div");
  div.className = "field-error-msg";
  div.textContent = msg;
  input.closest(".field-group").appendChild(div);
}

function markWarn(input, msg) {
  var div = document.createElement("div");
  div.className = "field-warn-msg";
  div.textContent = msg;
  input.closest(".field-group").appendChild(div);
}
```

**6c.** Replace `validateIdentity()` + the per-entry checks inside `handleSubmit` with one `validateAll()` that checks **everything at once** (no more submit-three-times):

```js
function validateAll() {
  clearFieldErrors();
  hideAlert();
  var bad = [];

  if (!staffNameInput.value.trim())
    { markError(staffNameInput, "Please enter your name 請輸入你的名字"); bad.push(staffNameInput); }
  if (!phoneInput.value.trim())
    { markError(phoneInput, "Please enter your phone number 請輸入電話號碼"); bad.push(phoneInput); }
  else if (!isValidHKPhone(phoneInput.value))
    { markError(phoneInput, "Must be a valid 8-digit HK mobile — payment goes to this number 必須是有效的8位香港手提號碼 — 款項將支付至此號碼"); bad.push(phoneInput); }

  var cards = $("jobEntries").querySelectorAll(".job-entry");
  cards.forEach(function (card) {
    var id = card.getAttribute("data-entry-id");
    var date = $("date_" + id), venue = $("venue_" + id), rate = $("rate_" + id);
    var start = $("start_" + id), end = $("end_" + id), pic = $("pic_" + id);

    if (!date.value) { markError(date, "Required 必填"); bad.push(date); }
    else if (date.value > todayStr()) { markError(date, "Date cannot be in the future 日期不能是未來"); bad.push(date); }
    if (!venue.value.trim()) { markError(venue, "Required 必填"); bad.push(venue); }
    if (!(parseFloat(rate.value) > 0)) { markError(rate, "Enter the day rate 請輸入日薪"); bad.push(rate); }
    if (!start.value) { markError(start, "Required 必填"); bad.push(start); }
    if (!end.value) { markError(end, "Required 必填"); bad.push(end); }
    if (!pic.value) { markError(pic, "Please choose the PIC 請選擇工作負責人"); bad.push(pic); }

    // Overnight: warn, don't block — surfaced again on the confirm screen
    if (start.value && end.value && end.value <= start.value) {
      markWarn(end, "End is not after start — overnight shift? 結束時間不晚於開始 — 通宵班？");
    }
  });

  if (bad.length > 0) {
    bad[0].scrollIntoView({ behavior: "smooth", block: "center" });
    try { bad[0].focus({ preventScroll: true }); } catch (_) { bad[0].focus(); }
    return false;
  }
  return true;
}
```

**6d.** Errors clear as the user types: add one delegated listener (near the other listeners):

```js
document.addEventListener("input", function (e) {
  if (e.target.classList && e.target.classList.contains("input-error")) {
    e.target.classList.remove("input-error");
    var grp = e.target.closest(".field-group");
    if (grp) grp.querySelectorAll(".field-error-msg").forEach(function (el) { el.remove(); });
  }
});
```
(Also handle `change` the same way for the PIC `<select>` — one extra listener with identical body.)

**6e.** Keep `showAlert`/`hideAlert` — still used for connection/server errors. Delete the now-unused `validateIdentity()`.

**Verify:** `grep -c "markError" deliverables/index.html` ≥ 9; `grep -n "inputmode" deliverables/index.html` → rate input.

---

## Task 7 — Frontend: confirm-before-submit screen

**Files:** Modify `deliverables/index.html`

**7a.** HTML — insert between `mainSection` and `statusSection`:

```html
<!-- ======== CONFIRM BEFORE SUBMIT ======== -->
<div id="confirmSection" class="hidden">
  <h2 style="font-size:1.1rem;font-weight:800;margin-bottom:12px;">Please confirm 請確認</h2>
  <div id="confirmBody"></div>
  <button class="btn btn-success" id="confirmSubmitBtn" type="button">
    Confirm &amp; Submit 確認提交
  </button>
  <button class="btn btn-ghost" id="confirmBackBtn" type="button" style="margin-top:8px;">
    ← Back to edit 返回修改
  </button>
</div>
```

**7b.** JS — `handleSubmit` becomes the gatekeeper; actual POST moves to `doSubmit`:

```js
function handleSubmit() {
  if (!validateAll()) return;
  showConfirm(collectEntries());
}

function showConfirm(entries) {
  var total = 0;
  var html =
    '<div class="confirm-identity">' +
      '<div class="confirm-name">' + escapeHtml(entries[0].staffName) + '</div>' +
      '<div>📱 ' + escapeHtml(entries[0].phoneNumber) + '</div>' +
      '<div style="font-size:0.8rem;margin-top:4px;">⚠️ Payment goes to this FPS name + number 款項將支付至此FPS名字及號碼</div>' +
    '</div>';

  entries.forEach(function (e, i) {
    total += e.basicRate;
    var overnight = e.endTime && e.startTime && e.endTime <= e.startTime;
    html +=
      '<div class="confirm-job">' +
        '<div class="confirm-job-line1">#' + (i + 1) + ' · ' + escapeHtml(e.dateOfWork) + ' — ' + escapeHtml(e.workVenue) +
          (overnight ? '<span class="overnight-tag">overnight 通宵</span>' : '') + '</div>' +
        '<div class="confirm-job-line2">$' + e.basicRate + ' · ' + escapeHtml(e.startTime) + '–' + escapeHtml(e.endTime) +
          ' · PIC: ' + escapeHtml(e.pic) + (e.notes ? ' · ' + escapeHtml(e.notes) : '') + '</div>' +
      '</div>';
  });

  html += '<div class="confirm-total"><span>Total 總額</span><span>$' + total + '</span></div>';

  $("confirmBody").innerHTML = html;
  mainSection.classList.add("hidden");
  $("confirmSection").classList.remove("hidden");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function hideConfirm() {
  $("confirmSection").classList.add("hidden");
  mainSection.classList.remove("hidden");
}
```

**7c.** Listeners: `$("confirmSubmitBtn").addEventListener("click", doSubmit);` and `$("confirmBackBtn").addEventListener("click", hideConfirm);`

**Verify:** `grep -n "confirmSection\|confirmSubmitBtn\|showConfirm" deliverables/index.html` — HTML section + JS + listeners all present. Buttons use `.btn` (48px invariant holds).

---

## Task 8 — Frontend: submit flow (accessCode, canonical phone, spinner) + success recap + dup warning

**Files:** Modify `deliverables/index.html`

**8a.** `collectEntries()`: change the phone line to `phoneNumber: normalizePhone(phoneInput.value),`.

**8b.** New `doSubmit` (replaces the old fetch half of `handleSubmit`; runs from the confirm screen):

```js
async function doSubmit() {
  var entries = collectEntries();
  saveIdentity();
  var btn = $("confirmSubmitBtn");
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner" aria-hidden="true"></span>Submitting... 提交中...';

  try {
    const res = await fetch(CONFIG.APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ action: "submit", accessCode: CONFIG.ACCESS_CODE, entries: entries }),
      redirect: "follow"
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    if (data.status === "success") {
      saveVenues(entries);
      clearDraft();
      renderSuccessRecap(entries, data.duplicates || []);
      $("confirmSection").classList.add("hidden");
      successSection.classList.add("active");
      hideAlert();
      window.scrollTo({ top: 0, behavior: "smooth" });
    } else {
      hideConfirm();
      showAlert((data.message || "Submission failed.") + " 提交失敗，請重試。", "error");
    }
  } catch (err) {
    hideConfirm();
    showAlert("Connection error. Please try again. 連接錯誤，請重試。", "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = "Confirm &amp; Submit 確認提交";
  }
}
```

**8c.** Success screen recap. HTML: inside `successSection`, after `.success-text`, add `<div id="successRecap" style="text-align:left;"></div>` and, after the `submitMoreBtn`, a ghost button `<button class="btn btn-ghost" id="successStatusBtn" type="button" style="margin-top:8px;">Check my status 查看我的提交狀態</button>`.

```js
function renderSuccessRecap(entries, duplicates) {
  var html = "";
  if (duplicates.length > 0) {
    html += '<div class="fps-notice"><span class="fps-title">⚠️ Possible duplicate 可能重複</span>' +
      'You may have already submitted for this date — please check your status.<br>' +
      '你可能已提交過此日期的紀錄，請查看提交狀態。</div>';
  }
  entries.forEach(function (e) {
    html += '<div class="confirm-job">' +
      '<div class="confirm-job-line1">' + escapeHtml(e.dateOfWork) + ' — ' + escapeHtml(e.workVenue) + '</div>' +
      '<div class="confirm-job-line2">$' + e.basicRate + ' · ' + escapeHtml(e.startTime) + '–' + escapeHtml(e.endTime) + '</div>' +
    '</div>';
  });
  html += '<p style="font-size:0.82rem;color:var(--gray-500);margin-top:12px;text-align:center;">' +
    'Your PM will review and approve. 你的PM將會審批。</p>';
  $("successRecap").innerHTML = html;
}
```

**8d.** Success → status shortcut:

```js
$("successStatusBtn").addEventListener("click", function () {
  successSection.classList.remove("active");
  $("jobEntries").innerHTML = "";
  jobEntryCount = 0;
  addJobEntry();
  showStatusChecker();          // hides mainSection again and prefills phone
});
```

**Verify:** `grep -n "accessCode" deliverables/index.html` → in submit payload (status payload added in Task 9); `grep -n "successRecap\|successStatusBtn" deliverables/index.html` → HTML + JS present. Old submit-button fetch code fully removed (`$("submitBtn")` listener now points at the new `handleSubmit`).

---

## Task 9 — Frontend: status checker hardening

**Files:** Modify `deliverables/index.html` (`checkStatus`, `showStatusChecker`)

- Payload gains the code: `body: JSON.stringify({ action: "status", accessCode: CONFIG.ACCESS_CODE, phoneNumber: normalizePhone(phone) })`.
- **Escape everything rendered from the server** in the results loop:
  - `escapeHtml(s.dateOfWork)`, `escapeHtml(s.workVenue)`, `escapeHtml(String(s.basicRate))`, `escapeHtml(s.startTime || '—')`, `escapeHtml(s.endTime || '—')`.
- `showStatusChecker` prefill: `$("statusPhone").value = normalizePhone(phone);`

**Verify:** `grep -c "escapeHtml" deliverables/index.html` — used in confirm, recap, AND status renderer (≥ 12 uses total).

---

## Task 10 — Frontend: 30-day sign-in + draft autosave

**Files:** Modify `deliverables/index.html`

**10a.** Auth persistence (replaces sessionStorage):

```js
var AUTH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function storeAuth() {
  try { localStorage.setItem("ts_auth_at", String(Date.now())); } catch (_) { }
}

function hasValidAuth() {
  try {
    if (sessionStorage.getItem("ts_auth") === "1") return true; // migrate old sessions
    var t = parseInt(localStorage.getItem("ts_auth_at") || "0", 10);
    return t > 0 && (Date.now() - t) < AUTH_TTL_MS;
  } catch (_) { return false; }
}
```

- In `checkAuth` success branch: replace the `sessionStorage.setItem` line with `storeAuth();`.
- `restoreSession()` body becomes `if (hasValidAuth()) { ...same show logic... }`.
- Factor the shared "enter the app" steps (hide auth, show main, loadIdentity, restoreDraft-or-addJobEntry) into one `enterMain()` called by both `checkAuth` and `restoreSession`.

**10b.** Draft autosave (survives Safari discarding the tab):

```js
var draftTimer = null;

function collectRawEntries() {
  var out = [];
  $("jobEntries").querySelectorAll(".job-entry").forEach(function (card) {
    var id = card.getAttribute("data-entry-id");
    out.push({
      date:  $("date_"  + id).value, venue: $("venue_" + id).value,
      rate:  $("rate_"  + id).value, start: $("start_" + id).value,
      end:   $("end_"   + id).value, pic:   $("pic_"   + id).value,
      notes: $("notes_" + id).value
    });
  });
  return out;
}

function scheduleDraftSave() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(function () {
    try { localStorage.setItem("ts_draft", JSON.stringify(collectRawEntries())); } catch (_) { }
  }, 500);
}

function clearDraft() {
  try { localStorage.removeItem("ts_draft"); } catch (_) { }
}

function restoreDraft() {
  var draft = null;
  try { draft = JSON.parse(localStorage.getItem("ts_draft") || "null"); } catch (_) { }
  if (!Array.isArray(draft) || draft.length === 0) return false;
  // never trust stored shape (see CLAUDE.md) — rebuild defensively
  $("jobEntries").innerHTML = "";
  jobEntryCount = 0;
  draft.forEach(function (d) {
    addJobEntry();
    var id = jobEntryCount;
    $("date_"  + id).value = d.date  || ""; $("venue_" + id).value = d.venue || "";
    $("rate_"  + id).value = d.rate  || ""; $("start_" + id).value = d.start || "";
    $("end_"   + id).value = d.end   || ""; $("pic_"   + id).value = d.pic   || "";
    $("notes_" + id).value = d.notes || "";
  });
  return true;
}
```

- In `enterMain()`: `if (!restoreDraft() && jobEntryCount === 0) addJobEntry();`
- Listeners (delegated, once): `$("jobEntries").addEventListener("input", scheduleDraftSave);` and `$("jobEntries").addEventListener("change", scheduleDraftSave);`
- `clearDraft()` is already called in `doSubmit` success (Task 8). Also call it in `handleSubmitMore`.
- Note: `addJobEntry()` inside `restoreDraft` triggers no draft save (saves only fire on user input) — no loop risk.

**Verify:** `grep -n "ts_draft\|ts_auth_at\|enterMain" deliverables/index.html` — all wired; no remaining `sessionStorage.setItem`.

---

## Task 11 — Sync copies + footer date

**Files:** Modify `deliverables/index.html`, overwrite root `index.html`

1. Footer: change `Last updated: 3 Jul 2026` → `Last updated: 7 Jul 2026`.
2. Copy: `cp "deliverables/index.html" "index.html"` (root copy is what GitHub Pages serves).

**Verify:** `diff index.html deliverables/index.html && echo IDENTICAL` → IDENTICAL.

---

## Task 12 — Docs (contract changed → docs must be regenerated)

**Files:** Modify `CLAUDE.md` (project), `deliverables/apps_script_setup.md`, `deliverables/sheet_setup_guide.md`

**12a.** `CLAUDE.md` Data Contract section:
- submit JSON: add `"accessCode": "..."` before `"entries"`; note phone is sent digits-only.
- status JSON: `{ "action": "status", "accessCode": "...", "phoneNumber": "..." }`
- Add one line: submit response is `{ "status": "success", "rowsAdded": n, "duplicates": [entry indexes flagged as possible duplicates] }`.
- Key Technical Notes: add a bullet — "Phone canonical form: digits only (spaces/dashes stripped) at every boundary; column C stores the canonical form."

**12b.** `apps_script_setup.md`:
- Step 3 becomes "Set Script Properties" covering **both** properties: `NOTION_API_KEY` (optional) and **`ACCESS_CODE`** (recommended — must equal `CONFIG.ACCESS_CODE` in index.html; if unset, the server check is skipped).
- Both curl examples gain `"accessCode":"YOUR_ACCESS_CODE"` and the submit example's phone becomes `"91230000"`.
- Expected submit response becomes `{"status":"success","rowsAdded":1,"duplicates":[]}`.
- Troubleshooting table: add row — `"Invalid access code" response | Script Property ACCESS_CODE doesn't match CONFIG.ACCESS_CODE in index.html`.

**12c.** `sheet_setup_guide.md`: final checklist line "Column N dropdown (Pending / Approved / Rejected)" → "(Pending / Approved / Rejected / Paid)".

**Verify:** `grep -n "accessCode" CLAUDE.md deliverables/apps_script_setup.md`; `grep -n "Paid" deliverables/sheet_setup_guide.md` shows the checklist fix.

---

## Final self-check (run all)

```bash
diff index.html deliverables/index.html && echo IDENTICAL
grep -c "btn btn" deliverables/index.html                     # all new buttons use .btn (48px)
grep -n "picOptions\|Not Sure" deliverables/Code.gs deliverables/index.html  # PIC lists still identical
grep -n "NOTION_API_KEY" deliverables/index.html              # MUST return nothing
node --check <(sed -n '/<script>/,/<\/script>/p' deliverables/index.html | sed '1d;$d')  # JS parses
```

Also eyeball: every new user-facing string is bilingual.

## Out of scope (deliberately)
- Language toggle, framework rewrite, serving PIC list from backend, PWA manifest.
- Real-device iOS check of date/time inputs — manual step for Michael after deploy.

## Post-merge deployment steps (for Michael — reviewer includes in final report)
1. Apps Script editor → paste new `Code.gs` → Save.
2. Project Settings → Script Properties → add `ACCESS_CODE` = the code in index.html.
3. Deploy → Manage deployments → ✏️ → **New version** → Deploy.
4. Push to GitHub (root `index.html`) → staff hard-refresh (Cmd+Shift+R / pull-to-refresh).
