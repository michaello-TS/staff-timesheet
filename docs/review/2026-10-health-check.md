# Staff Timesheet — Health Check, October 2026

Reviewed: `main` at `d40913a` (merge of PR #1, 2026-10-07). This review is read-only. No application code was changed.
Method: I read every file, ran a Node test harness against `deliverables/Code.gs` with stubbed Google services, and drove `index.html` in headless Chromium through Playwright. Every request to Google was intercepted, so nothing reached the live web app.

---

## 1. Plain-English summary

The system is mostly sound. Submitting, the status check, phone handling, month filtering, the Job_Summary totals and the HTML escaping all did what they should under test. The weak spots sit in the **payment hand-off**: the step where the PM approves rows, accounting pays from the FPS list, and someone clicks "Mark Approved as Paid". In four separate ways I could make a staff member get **paid twice, paid $0 or never paid**, with no warning on screen. There is also one **security gap**: the web app's public page lets anyone call the script's internal functions directly. That skips the access code, and it can use the Notion key to read or change the Notion HR data. Every fix below is small (an hour or two each). None of them changes the A–P column contract.

**Top 5 fixes, most important first**

1. **Close the back door to the script's functions** (finding A1). Today, anyone who opens the web-app link in a browser can run the script's functions directly, as you. That skips the access code entirely, and it can read or edit everything the Notion key can reach (staff phone numbers, work history). The fix is a one-line change to the health-check page, plus renaming the internal helpers.
2. **Show the amount owed on the FPS list, not the lifetime total** (P1). A person with some jobs already paid shows as "PARTIAL", and the money column shows paid plus unpaid together. If accounting follows the banner ("pay TO PAY rows only"), that person is skipped. The next "Mark Approved as Paid" then stamps the unpaid job as Paid, so they are never paid. If accounting pays the number shown instead, they are paid twice for the old jobs.
3. **Mark as Paid only what was actually on the payment list** (P2). If a PM approves a late job between "Refresh Payroll" and "Mark Approved as Paid", that job gets marked Paid even though nobody paid it.
4. **Make the Dashboard safety check compare the job, not just the person** (P3). After someone sorts the submissions tab, approving one of a person's jobs can hit a different job of the same person. In the test it flipped an already-**Paid** job back to "Approved", so it would be paid a second time.
5. **Show Notes, including the duplicate warning, on the Dashboard** (P4), and **stop a broken Final Rate from turning into $0** (P5). The "Possible duplicate" flag and staff notes such as "2h OT" never appear where PMs approve, so duplicates get approved and paid twice. Separately, if column M is blank or shows an error (for example, someone typed "200 (2h OT)" in column L), payroll silently pays $0 for that job.

---

## 2. Findings

Severity: **Must fix**, **Should fix** or **Nice to have**. Effort: **S** (under 2 h), **M** (half a day), **L** (more).
Confidence: **confirmed**, meaning the harness or Playwright reproduced it; or **likely**, meaning it follows from the code plus documented Google or Notion behaviour, but a live run is needed to be certain.

### A. Access control

| # | Where | What happens | Severity | Effort | Confidence |
|---|---|---|---|---|---|
| A1 | `deliverables/Code.gs:37-41` (`doGet` returns `HtmlService`), plus every function without a trailing `_`, e.g. `handleSubmit` :68, `handleStatus` :172, `showPendingDashboard` :278, `approveSelected` :422, `notionApiCall` :1204, `syncMonthlyToNotion` :1425 | The `/exec` health-check page is an HtmlService page, and Apps Script lets client code on such a page call **any** public server function through `google.script.run`. Google's docs say only functions whose names end in `_` are hidden. The web app runs as the owner with access "Anyone". So a visitor who opens `/exec` and types one line into the browser console can call `handleSubmit({...})` or `handleStatus({...})` with **no access code**. They can also call `notionApiCall("search","post",{})` (or a PATCH) to read or edit anything the Notion integration can see, or `showPendingDashboard()` to wipe a PM's half-filled Dashboard. Functions that call `getUi()` first (payroll, mark-paid) fail in web context, so pay status itself is not reachable this way. The harness confirmed the bypass at function level: direct calls append rows and return records without a code, and `notionApiCall` sends the owner's key to whatever endpoint it is given. **Fix:** make `doGet` return `ContentService.createTextOutput("Timesheet API is running…")`. That leaves no HtmlService page on `/exec`, which closes the hole. For defence in depth, add `_` to the helpers that don't need to be public (`handleSubmit_`, `handleStatus_`, `notionApiCall_`, `queryNotionDB_`, and so on). Keep public only `doGet`, `doPost`, `onOpen`, the menu items and the two dialog callbacks. | Must fix | S | likely (function-level bypass confirmed; reachability needs live check L1) |

`doPost` itself is fine: both `submit` and `status` are gated by `_checkAccessCode` (`Code.gs:49`), and the harness confirmed a wrong code is rejected for both.

### P. Payroll correctness

| # | Where | What happens | Severity | Effort | Confidence |
|---|---|---|---|---|---|
| P1 | `Code.gs:765` (banner), `:784` (column D = `fStaff.total`), `:789-791` | The FPS list has one money column, "Total". For a **PARTIAL** person it shows paid plus unpaid together, and no per-person "to pay" figure appears anywhere. Test: a staff member had one Sep job already paid, then a late Sep job was approved. The FPS row showed `Total 1700, PARTIAL`, but only 900 was owed. If accounting follows the banner ("pay TO PAY rows only") and then runs Mark-as-Paid for Sep, the unpaid job becomes **Paid without being paid** (confirmed). If accounting pays the Total instead, the old job is paid twice. **Fix:** make column D `sm.toPay` (labelled "To Pay 待支付"), move the lifetime total to its own column or drop it, and change the banner to "pay the To Pay amount". | Must fix | S | confirmed |
| P2 | `Code.gs:1138-1179` (`runMarkPaidForMonths`) | Mark-as-Paid flips **every row that is Approved right now** in the chosen months. It does not limit itself to the rows that were on the FPS list accounting paid from. Test: payroll built with 800 to pay → PM approves a late job worth 1000 → Mark-as-Paid marks 1800 as Paid. The confirm dialog shows the new total, but nothing compares it with the list that was paid. **Fix:** in `runPayrollForMonths`, save the row numbers and To-Pay total in `DocumentProperties`. Mark-as-Paid then marks only those rows, and warns if any have changed. As a minimum, show "Last payment list: $X · About to mark: $Y" and stop when they differ. | Must fix | S–M | confirmed |
| P3 | `Code.gs:480-488` (stale-row guard) | The guard only checks that **name + phone** still match at the stored row number. Staff often have several rows, so after a sort the row number can point at a different job of the same person, and the guard passes. It also never checks that the row is still Pending. Test: staff A has a Paid August job and a Pending September job. The PM sorts the tab by date, then approves A's September job from the Dashboard. The **August Paid row became "Approved"** with the new project number, so it reappears as TO PAY. The September job stayed Pending (confirmed). **Fix:** also compare date (D), venue (E) and rate (F), and require status N to still be `Pending`. Otherwise count the row as mismatched. | Must fix | S | confirmed |
| P4 | `Code.gs:128` (duplicate flag goes into Notes) vs `Code.gs:335` (Dashboard columns have no Notes) | The "⚠️ Possible duplicate 可能重複" flag and every staff note (for example an OT remark) are written to column I, but the Dashboard where PMs approve never shows column I. The only other place the flag appears is the email. Test: the same job was submitted twice; both rows showed on the Dashboard identically, both approved, and the FPS list showed 2 jobs, 1600 (confirmed). There is no red or yellow highlight in the code on `main` (`clearConditionalFormatRules` at :292 wipes any on the Dashboard). **Fix:** add a "Notes 備註" column **after** Role (Dashboard column L) so the indexes `_applyStatus` reads (`[8]`, `[9]`, `[10]`) don't move, and shade rows whose notes contain "duplicate". | Must fix | S | confirmed |
| P5 | `Code.gs:713,724` (payroll), `:936-937` (Job_Summary), `:1150-1151` (mark-paid total), `:1471,1526` (Notion) | Every reader does `parseFloat(M) \|\| 0`. When M shows `#VALUE!` (text in L, e.g. "200 (2h OT)") or is blank (a row typed by hand without the formula, or pasted as values), the job is counted as **$0**, with no warning on the FPS list or in the "Payroll refreshed" alert (confirmed for both cases). **Fix:** if M isn't a number, compute `F + (L or 0)` in script when both are numbers. Otherwise list the row numbers in the alert ("3 rows have no valid Final Rate — fix before paying") and highlight them. | Must fix | S | confirmed |

These checks passed: the column M formula is written correctly on submit; the month filter correctly excluded a 31 Aug job from the Sep payroll; the Job_Summary grand total matched by hand (basic + OT across months and staff); **running Mark-as-Paid twice is safe**, since the second run finds nothing.

### D. Lost or doubled data

| # | Where | What happens | Severity | Effort | Confidence |
|---|---|---|---|---|---|
| D1 | `index.html:1182-1187` (`confirmSavedAfterError`) | After a lost reply, the form counts the job as "saved" if **any** record exists with the same date, venue and rate. It ignores start and end times, ignores Rejected status, and doesn't check whether that record was already there before. Test (Playwright, submit request aborted so nothing reached the server): an earlier record for the same day, venue and rate, but a different shift (10:00–13:00 vs 10:00–18:00), made the form say **"✅ Saved — please do NOT submit it again"**. The same happened when the earlier record was **Rejected**. The staff member is told not to resubmit, so the job is never recorded and never paid. **Fix:** also match `startTime`/`endTime` and skip `Rejected`. Better still, count matching records before submitting (the confirm screen already fetches them, `index.html:1110-1123`) and require the count to go **up**. | Should fix | S | confirmed |
| D2 | `Code.gs:120-160` (append loop), `:61-63`; `index.html:1220-1222` | In a 3-job submit, if a sheet write fails after job 1, job 1 stays saved, no PM email is sent, and the reply is `{status:"error"}`. The form then says "提交失敗，請重試" (failed, please retry) without checking what was saved. When the staff member retries, job 1 is duplicated, and per P4 the PM can't see the duplicate flag (confirmed in harness and Playwright). Rare, because it needs a Google service error mid-loop. **Fix (front end only):** treat any non-access-code error after submit like a lost reply, i.e. run `confirmSavedAfterError` and say which jobs are saved. A server-side replay guard would also cover this, but it isn't needed if D1 and D2 are fixed. | Should fix | S | confirmed |

These checks passed: a lock timeout (`Code.gs:100`) returns an error before anything is written; the form's honest "Could not confirm, check status first" message appears when nothing matches; double-tapping Confirm is blocked (the button disables before the first `await`).

### I. Injection and escaping

| # | Where | What happens | Severity | Effort | Confidence |
|---|---|---|---|---|---|
| I1 | `Code.gs:135-152` (`appendRow`) | Free text (Name, Venue, Notes) is passed to `appendRow` unchanged. Sheets treats a value starting with `=` as a **formula**. So a note such as `=IMPORTXML("https://…?"&B2&C2, …)` from anyone holding the access code (or anyone using A1) runs inside your sheet, and could send other rows' names and phone numbers to an outside server when a PM opens the sheet. Text starting with `+` or `-` (e.g. "-30 min break", "+WOW Mall") may also be parsed as a formula and show `#ERROR!` (see live check L2). The harness confirmed the values reach `appendRow` unescaped. **Fix:** in `handleSubmit`, prefix `'` to any text field that starts with `= + - @`. Sheets hides the apostrophe, so the status view and payroll are unaffected. | Should fix | S | likely (code path confirmed; Sheets parsing needs live check) |

These checks passed: the PM email is plain text (`MailApp.sendEmail(to, subject, body)`, `Code.gs:257`), so there is no HTML injection; hostile values in a status reply (`<img onerror>`, `<script>`) were shown as text and no script ran (Playwright); month values in the month-picker dialog are regex-checked (`Code.gs:553`, `:577`).

### N. Notion sync

| # | Where | What happens | Severity | Effort | Confidence |
|---|---|---|---|---|---|
| N1 | `Code.gs:1292-1297`, `:1363-1380` | Notion includes **at most 25** relation links in a page or query result (`has_more: true` beyond that; Notion "Page properties" reference). The code treats that list as complete and **replaces** the whole relation. For a crew member with more than 25 "Jobs Assigned", every sync silently **deletes** their older job links. The harness confirmed the write sends 25 old + 1 new. **Fix:** read the full list from `GET pages/{id}/properties/{property_id}` (paginated), or check `has_more` and skip the relation update with a WARNING. | Should fix | M | likely (harness + Notion docs) |
| N2 | `Code.gs:1286-1289`, `:1384-1390` | The Work Log is read from `rich_text[0]` only and written back as one text block. (1) If the log was ever split (edited in Notion with formatting, or over 2000 characters), everything after the first part is **overwritten and lost** (confirmed). (2) Notion rejects a text block over 2000 characters. After about 40–50 jobs, that person's rows fail with an ERROR on **every** sync and are never stamped in P (confirmed with a fake Notion that applies the documented limit). **Fix:** join all `rich_text` parts when reading, and write back in 2000-character chunks. Or keep only the most recent N lines. | Should fix | S–M | confirmed (limits from Notion docs) |
| N3 | `Code.gs:1523-1536` | The work log is appended **before** column P is stamped. If the run stops between the two (the 6-minute Apps Script limit on a large first sync, which here runs inside the same call as Refresh Payroll and its dialogs), the next sync appends the same line again. That makes the Notion work history wrong, but pay is not affected. **Fix:** stamp P right after `appendWorkLog`, or stop the loop cleanly at about 5 minutes and tell the PM to run it again. | Nice to have | S | likely |

Rate limits are handled acceptably at this scale: one retry after a 429, 400 ms between calls, and failed rows are not stamped, so they retry next time.

### F. Front end / other

| # | Where | What happens | Severity | Effort | Confidence |
|---|---|---|---|---|---|
| F1 | `index.html:679-685`, `:1220-1222` | If the owner ever changes `ACCESS_CODE`, phones that remember the old code skip the code screen for up to 30 days, and **every** submit fails with "Invalid access code … 請重試", with no way back to the code screen except clearing browser data (confirmed). **Fix:** on an "access code" error, clear `ts_code`/`ts_auth_at` and show the code screen. | Nice to have | S | confirmed |
| F2 | `index.html:190-196` (`.btn-ghost min-height: 40px`), `:224-234` (remove ✕) | This breaks the "buttons ≥48px" invariant. Measured at 390 px wide: "+ Add another job" and "Check my submission status" are 42 px, and the ✕ remove button is 28 px. **Fix:** `min-height: 48px` on `.btn-ghost`, and a 44–48 px hit area on `.remove-job-btn`. | Nice to have | S | confirmed |
| F3 | `README.md:12`, `:89`, `:81`, `:87`, `:108` | The docs are out of date in ways that matter to accounting. "Paid rows drop out of the next payroll run" is false: they stay on the list as PAID and are included in "Total", which is what feeds P1. "Enter the month" is now a checkbox dialog. "The access code is stored in the page source" was true before PR #1. **Fix:** update the README wording (and P1's banner). | Nice to have | S | confirmed |

**Phone canonical form:** no problems. Digits-only at submit (`Code.gs:138`), status (`:193`), duplicate check (`:109`), payroll and Job_Summary grouping (`:709`, `:933`) and Notion (`:1469`). A legacy `"XXXX XXXX"` row and a digits-only row merged into one FPS line, and the status check found both (confirmed). `+852 …` is blocked with a clear bilingual message rather than saved wrong (Playwright). The `findCrewByPhone` fallback (`Code.gs:1272-1276`) covers only the `"XXXX XXXX"` form; see L6.

**Dates and times:** no problems. Pay is a day rate, so no hours are calculated and an overnight shift can't distort pay. It is filed under its start date, i.e. the month the shift began. Dates are formatted in `Asia/Hong_Kong` and times in the sheet's own timezone. These agree as long as the sheet stays on Hong Kong time (L4). The month boundary test (31 Aug vs 1 Sep) passed.

**Stale Dashboard:** see P3. The other stale case, sheet rows added or removed, is caught by the existing guard as long as the person differs.

---

## 3. Needs live check (only checkable on the real Sheet / Apps Script / Notion)

- **L1 — A1 reachability.** In a private browser window, open the `/exec` link. Open the browser console and pick the inner `userCodeAppPanel` frame. Run `google.script.run.withSuccessHandler(console.log).handleStatus({phoneNumber:"00000000"})`. A `{status:"success",submissions:[]}` reply proves the bypass. This call is read-only and harmless.
- **L2 — leading `+`/`-` text.** Type `-30 min break` into a spare cell in `Timesheet_Submissions`. If it shows `#ERROR!`, include `+`/`-` in the I1 fix. Also filter columns E and I for `#ERROR!`/`#NAME?`.
- **L3 — column M health.** Filter column M for blanks and `#VALUE!` on Approved rows; each one is currently counted as $0 (P5).
- **L4 — timezone.** File → Settings → Time zone must still be `(GMT+08:00) Hong Kong`.
- **L5 — Project No. format.** When the Dashboard writes the project number back (`Code.gs:495`), Sheets may turn values like `0123` into `123`, or `2026-09` / `9/1` into dates. A converted value breaks Job_Summary grouping and the Notion Hiring Post match. Check column J for numbers that lost a leading zero or for dates. If any appear, format column J (and Dashboard column I) as plain text.
- **L6 — Notion Crew phone formats.** If any Crew pages store phones as `+852 …` or with dashes, `findCrewByPhone` misses them and creates a duplicate Crew page.
- **L7 — Notion limits in real data.** Any crew member with more than 25 Jobs Assigned (N1), or a Work Log near 2000 characters (N2)? Do repeated `ERROR … 2000` rows appear in Sync_Log?
- **L8 — Notion read-after-write.** In one sync, a staff member with two new rows gets two crew lookups. If Notion returns the stale page the second time, the second update would overwrite the first row's new link and log line. Sync a test person with two rows and check that both links and both log lines survive. If they don't, cache crew state per phone within the run.
- **L9 — highlights.** The brief mentions red/yellow duplicate highlights, but none exist in the code on `main`. Check whether a manual conditional-format rule exists on `Timesheet_Submissions`. It would not appear on the Dashboard (P4).
- **L10 — deployed version.** Confirm the code in the Apps Script editor matches `main`, and that the deployment uses the latest version.
- **L11 — `ACCESS_CODE` is set** in Script Properties (fail-open behaviour when it is missing is known; this just confirms it isn't missing).

---

## 4. What I ran

**Syntax.** `cp deliverables/Code.gs /tmp/code.js && node --check /tmp/code.js` → OK (Node 22).
`index.html` and `deliverables/index.html` are byte-identical (`cmp`).

**Backend harness.** This was throwaway code outside the repo and is not committed. Node `vm` loads `Code.gs` with stubs for SpreadsheetApp (an in-memory sheet that turns ISO dates and HH:mm into Date cells the way Sheets does, stores `=`-text as formulas, evaluates the column M formula including `#VALUE!`, and supports sorting), LockService (with an optional timeout), PropertiesService, ContentService, HtmlService, Utilities.formatDate (real IANA time zones), MailApp, Session, Logger, UrlFetchApp (a fake Notion that enforces the documented 2000-character and 25-relation behaviour), and `getUi()` (an alert recorder, which throws in "web context" to mimic `/exec`).
Result: **35 checks, 35 confirmed.** Covered: submit/status/duplicate flag; the access code on both actions; direct-call bypass (A1); lock timeout; partial write (D2); M `#VALUE!`/blank → $0 (P5); PARTIAL FPS row and the Mark-Paid consequence (P1); stale payment list (P2); Mark-Paid run twice; sorted-sheet approve flipping a Paid row (P3); Notes missing from the Dashboard (P4); formula text reaching `appendRow` (I1); plain-text email; month filter; Job_Summary grand total; Notion relation truncation, multi-part log and 2000-character error (N1, N2); P stamp on success; legacy phone merge.

**Front end (Playwright 1.56, Chromium headless, 390×844).** `python3 -m http.server` served the repo. Every `script.google.com` request was intercepted with `page.route` and answered with canned JSON, or aborted to simulate a lost reply.
Result: **8 checks, 8 confirmed.** Covered: false "Saved" from an earlier different-shift record, and from a Rejected record (D1); honest "could not confirm" when nothing matches; server error → "failed, retry" with no status check (D2); stale access code trap (F1); status-view XSS safe; button heights (F2); `+852` phone rejected with a bilingual message.

Not run: anything against the live Sheet, the `/exec` URL or Notion. Those items are in section 3.
