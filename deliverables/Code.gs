/**
 * ============================================================
 *  Staff Timesheet System — Google Apps Script Backend
 *  Handles timesheet submissions from the staff web app.
 *  工作紀錄系統 — Google Apps Script 後端
 * ============================================================
 */

// ─── Constants ──────────────────────────────────────────────
var SHEET_NAME = "Timesheet_Submissions";
var TIMEZONE   = "Asia/Hong_Kong";

// Canonical phone form used EVERYWHERE (dup check, status, payroll, Notion sync)
function _normPhone_(p) {
  return String(p || "").replace(/[\s\-]/g, "");
}

// Time-of-day cells (cols G/H) are stored as times on 1899-12-30. Format them in
// the SHEET's own timezone — formatting in Asia/Hong_Kong shifts them by +7:36
// (HK's 1899 local-mean-time offset) whenever the sheet is set to another zone.
function _fmtTime_(v) {
  if (!(v instanceof Date)) return String(v).trim();
  var tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  return Utilities.formatDate(v, tz, "HH:mm");
}

// The only copy of the access code (Script Property ACCESS_CODE). The web page
// holds no code: it sends whatever staff type and this check decides. If the property is missing,
// the check is skipped (so an un-configured deployment keeps working).
function _checkAccessCode_(payload) {
  var expected = PropertiesService.getScriptProperties().getProperty("ACCESS_CODE");
  if (!expected) return true;
  return String(payload.accessCode || "") === expected;
}

// ─── doGet — Health Check ───────────────────────────────────
// Plain text, NOT HtmlService: any HtmlService page lets its visitor call every
// public server function via google.script.run, running as the owner and
// skipping the access code. Server functions that the menu / month dialog don't
// call by name must end in "_" (private).
function doGet(e) {
  return ContentService.createTextOutput("Timesheet API is running. 工作紀錄系統運作中。");
}

// "yyyy-MM-dd" for a Date-of-Work cell (Sheets may hold a Date or text)
function _dateStr_(v) {
  return (v instanceof Date) ? Utilities.formatDate(v, TIMEZONE, "yyyy-MM-dd") : String(v).trim();
}

function _toNum_(v) {
  if (typeof v === "number") return v;
  var s = String(v).trim();
  return /^-?\d+(\.\d+)?$/.test(s) ? parseFloat(s) : NaN;
}

// Final Rate for a Timesheet_Submissions row (array of A–P values).
// Uses column M; if M is blank / an error, falls back to F + L (what the formula
// would give). ok:false means it can't be worked out — never pay it as $0.
function _finalRate_(row) {
  var m = _toNum_(row[12]);
  if (!isNaN(m) && m > 0) return { amount: m, ok: true };
  var f = _toNum_(row[5]);
  var l = (String(row[11]).trim() === "") ? 0 : _toNum_(row[11]);
  if (!isNaN(f) && !isNaN(l) && f + l > 0) return { amount: f + l, ok: true };
  return { amount: 0, ok: false };
}

// ─── doPost — Main Entry Point ──────────────────────────────
function doPost(e) {
  try {
    var payload = JSON.parse(e.postData.contents);
    var action  = payload.action;

    if (!_checkAccessCode_(payload)) {
      return _jsonResponse_({ status: "error", message: "Invalid access code. 存取碼不正確。" });
    }

    if (action === "submit") {
      return _jsonResponse_(handleSubmit_(payload));
    } else if (action === "status") {
      return _jsonResponse_(handleStatus_(payload));
    } else {
      return _jsonResponse_({ status: "error", message: "Unknown action: " + action });
    }

  } catch (err) {
    Logger.log("doPost error: " + err.toString());
    return _jsonResponse_({ status: "error", message: err.toString() });
  }
}

// ─── Action: Submit Timesheet ───────────────────────────────
function handleSubmit_(payload) {
  var entries = payload.entries;
  if (!entries || !entries.length) {
    return { status: "error", message: "No entries provided." };
  }

  // Server-side sanity check — the endpoint is public, never trust the payload
  for (var v = 0; v < entries.length; v++) {
    var en = entries[v];
    var okEntry = en &&
      String(en.staffName || "").trim() &&
      /^[4-9]\d{7}$/.test(_normPhone_(en.phoneNumber)) &&
      /^\d{4}-\d{2}-\d{2}$/.test(String(en.dateOfWork || "")) &&
      String(en.workVenue || "").trim() &&
      parseFloat(en.basicRate) > 0 &&
      String(en.startTime || "") &&
      String(en.endTime || "");
    if (!okEntry) {
      return { status: "error", message: "Invalid data in entry " + (v + 1) + "." };
    }
  }

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  if (!sheet) {
    return { status: "error", message: "Sheet '" + SHEET_NAME + "' not found." };
  }

  var rowsAdded = 0;

  // Lock so two people submitting at the same moment can't interleave —
  // appendRow + getLastRow below assumes no other writer between the two calls
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    // Build a phone+date lookup of existing rows for duplicate detection
    var existingPairs = {};
    var existingLast = sheet.getLastRow();
    if (existingLast >= 2) {
      var prev = sheet.getRange(2, 3, existingLast - 1, 2).getValues(); // C: Phone, D: Date
      for (var k = 0; k < prev.length; k++) {
        var prevPhone = _normPhone_(prev[k][0]);
        var prevDate  = prev[k][1];
        prevDate = (prevDate instanceof Date)
          ? Utilities.formatDate(prevDate, TIMEZONE, "yyyy-MM-dd")
          : String(prevDate).trim();
        existingPairs[prevPhone + "|" + prevDate] = true;
      }
    }

    var dupIndexes = [];

    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      var timestamp = Utilities.formatDate(new Date(), TIMEZONE, "yyyy-MM-dd HH:mm");

      // Flag possible duplicates (same phone + same date already in the sheet)
      var dupKey = _normPhone_(entry.phoneNumber) + "|" + String(entry.dateOfWork || "").trim();
      var notes = entry.notes || "";
      if (existingPairs[dupKey]) {
        notes = (notes ? notes + " " : "") + "⚠️ Possible duplicate 可能重複";
        entry._dup = true;
        dupIndexes.push(i + 1);
      }
      existingPairs[dupKey] = true; // also catches duplicates within this same submission

      // Append the row (columns A–P)
      sheet.appendRow([
        timestamp,                        // A: Submission Timestamp
        entry.staffName,                  // B: Staff Name
        _normPhone_(entry.phoneNumber),    // C: Phone Number (canonical, digits only)
        entry.dateOfWork,                 // D: Date of Work
        entry.workVenue,                  // E: Work Venue
        entry.basicRate,                  // F: Basic Rate ($)
        entry.startTime,                  // G: Start Time
        entry.endTime,                    // H: End Time
        notes,                            // I: Notes (+ duplicate flag if detected)
        "",                               // J: Project No. (PM fills on approve)
        entry.pic || "",                  // K: PIC (Project In-Charge) — staff picks
        "",                               // L: OT Compensation (blank)
        "",                               // M: Final Rate — formula set below
        "Pending",                        // N: Status
        "",                               // O: Role (PM fills on approve)
        ""                                // P: Synced (auto-filled by sync)
      ]);

      // Write the Final Rate formula into column M for the newly appended row
      var lastRow = sheet.getLastRow();
      var formulaM = '=IF(L' + lastRow + '="", F' + lastRow + ', F' + lastRow + '+L' + lastRow + ')';
      sheet.getRange("M" + lastRow).setFormula(formulaM);

      rowsAdded++;
    }
  } finally {
    lock.releaseLock();
  }

  // Email the PM a notification about this submission
  _notifyPM_(entries);

  return { status: "success", rowsAdded: rowsAdded, duplicates: dupIndexes };
}

// ─── Action: Check Staff Submission Status ───────────────────
function handleStatus_(payload) {
  var phone = String(payload.phoneNumber || "").trim();
  if (!phone) {
    return { status: "error", message: "Phone number required." };
  }

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  if (!sheet) {
    return { status: "error", message: "Sheet not found." };
  }

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return { status: "success", submissions: [] };
  }

  var data = sheet.getRange(2, 1, lastRow - 1, 16).getValues();
  var submissions = [];

  for (var i = 0; i < data.length; i++) {
    // Compare canonical phone forms
    if (_normPhone_(data[i][2]) === _normPhone_(phone)) {
      var dateOfWork = data[i][3];
      if (dateOfWork instanceof Date) {
        dateOfWork = Utilities.formatDate(dateOfWork, TIMEZONE, "yyyy-MM-dd");
      } else {
        dateOfWork = String(dateOfWork).trim();
      }
      var st = data[i][6];
      var et = data[i][7];
      submissions.push({
        dateOfWork: dateOfWork,
        workVenue:  String(data[i][4]).trim(),
        basicRate:  data[i][5],
        startTime:  _fmtTime_(st),
        endTime:    _fmtTime_(et),
        status:     String(data[i][13]).trim()
      });
    }
  }

  // Most recent first
  submissions.sort(function(a, b) {
    return (a.dateOfWork > b.dateOfWork) ? -1 : (a.dateOfWork < b.dateOfWork) ? 1 : 0;
  });

  return { status: "success", submissions: submissions };
}

// ─── PM Email Notification ───────────────────────────────────
function _notifyPM_(entries) {
  try {
    // Automatically uses the email of whoever owns the script — no config needed
    var pmEmail = Session.getEffectiveUser().getEmail();
    if (!pmEmail) return;

    var staffName = entries[0].staffName;
    var phone     = entries[0].phoneNumber;
    var total     = 0;
    var lines     = [];

    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      var rate = parseFloat(e.basicRate) || 0;
      total += rate;
      lines.push(
        "  • " + e.dateOfWork + " — " + e.workVenue +
        " ($" + rate + ", " + e.startTime + "–" + e.endTime + ")" +
        (e._dup ? "  ⚠️ POSSIBLE DUPLICATE — same phone + date already submitted" : "")
      );
    }

    var subject =
      "New timesheet from " + staffName +
      " (" + entries.length + " job" + (entries.length > 1 ? "s" : "") + ")";

    var body =
      "New timesheet submission received:\n\n" +
      "Staff:  " + staffName + "\n" +
      "Phone:  " + phone + "\n" +
      "Jobs:   " + entries.length + "\n\n" +
      lines.join("\n") + "\n\n" +
      "Total basic pay: $" + total + "\n\n" +
      "Open your Google Sheet → Timesheet → Show Pending to review and approve.";

    MailApp.sendEmail(pmEmail, subject, body);
  } catch (err) {
    // Log but don't fail the submission if email breaks
    Logger.log("Email notification failed: " + err.toString());
  }
}

// ─── Custom Menu ────────────────────────────────────────────
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("Timesheet ⏱")
    .addItem("Show Pending 顯示待審批", "showPendingDashboard")
    .addItem("✓ Approve Checked 批准已選", "approveSelected")
    .addItem("✕ Reject Checked 拒絕已選", "rejectSelected")
    .addSeparator()
    .addItem("Refresh Payroll 更新薪資表", "refreshPayroll")
    .addItem("💰 Mark Approved as Paid 標記已支付", "markApprovedAsPaid")
    .addToUi();
}

// ─── Show Pending Submissions in Dashboard ───────────────────
function showPendingDashboard() {
  var ss  = SpreadsheetApp.getActiveSpreadsheet();
  var src = ss.getSheetByName(SHEET_NAME);
  if (!src) {
    SpreadsheetApp.getUi().alert("Sheet 'Timesheet_Submissions' not found.");
    return;
  }

  // Get or create Dashboard tab
  var dash = ss.getSheetByName("Dashboard");
  if (!dash) {
    dash = ss.insertSheet("Dashboard");
  }
  dash.clear();
  dash.clearConditionalFormatRules();
  // clear() leaves checkbox data-validations behind — wipe them so a shorter
  // list doesn't show ghost checkboxes from the previous run
  dash.getRange(1, 1, dash.getMaxRows(), dash.getMaxColumns()).clearDataValidations();

  var lastRow = src.getLastRow();
  if (lastRow < 2) {
    dash.getRange(1, 1).setValue("No submissions yet. 尚無提交紀錄。");
    ss.setActiveSheet(dash);
    return;
  }

  var data = src.getRange(2, 1, lastRow - 1, 16).getValues();

  // Collect rows where Status = "Pending", keep source row number
  var pendingRows = [];
  for (var i = 0; i < data.length; i++) {
    if (String(data[i][13]).trim() === "Pending") {
      pendingRows.push({ srcRow: i + 2, data: data[i] });
    }
  }

  if (pendingRows.length === 0) {
    dash.getRange(1, 1).setValue("No pending submissions. All caught up! 全部已審批！");
    ss.setActiveSheet(dash);
    SpreadsheetApp.getUi().alert("No pending submissions. All caught up! 全部已審批！");
    return;
  }

  // ── Column widths ──
  dash.setColumnWidth(1, 40);   // A: Checkbox
  dash.setColumnWidth(2, 50);   // B: Row ref (small, for internal use)
  dash.setColumnWidth(3, 130);  // C: Staff Name
  dash.setColumnWidth(4, 110);  // D: Phone
  dash.setColumnWidth(5, 100);  // E: Date
  dash.setColumnWidth(6, 160);  // F: Venue
  dash.setColumnWidth(7, 90);   // G: Rate
  dash.setColumnWidth(8, 100);  // H: Hours
  dash.setColumnWidth(9, 110);  // I: Project No.
  dash.setColumnWidth(10, 110); // J: PIC
  dash.setColumnWidth(11, 130); // K: Role
  dash.setColumnWidth(12, 220); // L: Notes (staff notes + duplicate flag)

  // ── Header row ──
  // Notes stays LAST so _applyStatus_'s column indexes (I/J/K) don't move
  var headers = ["✓", "Row#", "Staff Name 姓名", "Phone 電話", "Date 日期", "Venue 地點", "Rate $ 日薪", "Hours 時間", "Project No. 專案編號", "PIC 工作負責人", "Role 角色", "Notes 備註"];
  var headerRange = dash.getRange(1, 1, 1, headers.length);
  headerRange.setValues([headers]);
  headerRange.setBackground("#2563EB");
  headerRange.setFontColor("#FFFFFF");
  headerRange.setFontWeight("bold");
  headerRange.setHorizontalAlignment("center");
  headerRange.setFontSize(10);

  // ── PIC dropdown options (Data Validation) ──
  var picOptions = SpreadsheetApp.newDataValidation()
    .requireValueInList(["Kamdi", "Rufus", "Steve", "Michael", "Not Sure / 未確定"], true)
    .setAllowInvalid(false)
    .build();

  // ── Role dropdown options (Data Validation) ──
  var roleOptions = SpreadsheetApp.newDataValidation()
    .requireValueInList(["Event Helper", "Promoter", "Workshop Tutor", "Model/Talent", "Pet+Owner", "Parent+Child", "Other"], true)
    .setAllowInvalid(false)
    .build();

  // ── Data rows ──
  var dupCount = 0;
  for (var r = 0; r < pendingRows.length; r++) {
    var pr     = pendingRows[r];
    var d      = pr.data;
    var rowNum = r + 2;

    var dateOfWork = d[3];
    if (dateOfWork instanceof Date) {
      dateOfWork = Utilities.formatDate(dateOfWork, TIMEZONE, "yyyy-MM-dd");
    } else {
      dateOfWork = String(dateOfWork).trim();
    }

    // Checkbox in col A
    var cbRange = dash.getRange(rowNum, 1);
    cbRange.insertCheckboxes();
    cbRange.setValue(false);
    cbRange.setHorizontalAlignment("center");

    // Source row number in col B (gray — just a reference)
    dash.getRange(rowNum, 2).setValue(pr.srcRow)
      .setFontColor("#AAAAAA").setHorizontalAlignment("center").setFontSize(9);

    // Data cols C–H
    dash.getRange(rowNum, 3).setValue(String(d[1]).trim());
    dash.getRange(rowNum, 4).setValue(String(d[2]).trim());
    dash.getRange(rowNum, 5).setValue(dateOfWork);
    dash.getRange(rowNum, 6).setValue(String(d[4]).trim());
    dash.getRange(rowNum, 7).setValue(d[5]).setNumberFormat("$#,##0");
    var startTime = _fmtTime_(d[6]);
    var endTime   = _fmtTime_(d[7]);
    dash.getRange(rowNum, 8).setValue(startTime + "–" + endTime);

    // Project No. in col I — pre-fill from Timesheet_Submissions col J if already set
    var existingProjectNo = String(d[9]).trim();
    dash.getRange(rowNum, 9).setValue(existingProjectNo);

    // PIC in col J — dropdown with pre-fill from Timesheet_Submissions col K (staff picked)
    var existingPic = String(d[10]).trim();
    var picCell = dash.getRange(rowNum, 10);
    picCell.setValue(existingPic);
    picCell.setDataValidation(picOptions);

    // Role in col K — dropdown with pre-fill from Timesheet_Submissions col O if already set
    var existingRole = String(d[14]).trim();
    var roleCell = dash.getRange(rowNum, 11);
    roleCell.setValue(existingRole);
    roleCell.setDataValidation(roleOptions);

    // Notes in col L — staff notes + the "Possible duplicate" flag from submit.
    // Leading apostrophe keeps a note like "=..." or "-30 min" as plain text.
    var notes = String(d[8]).trim();
    dash.getRange(rowNum, 12).setValue(notes ? "'" + notes : "");

    // Possible duplicates in red (check before approving); else alternating shade
    if (/duplicate/i.test(notes)) {
      dash.getRange(rowNum, 1, 1, 12).setBackground("#FDDEDE");
      dupCount++;
    } else if (r % 2 === 1) {
      dash.getRange(rowNum, 1, 1, 12).setBackground("#F0F4FF");
    }
  }

  ss.setActiveSheet(dash);
  SpreadsheetApp.getUi().alert(
    pendingRows.length + " pending submission(s) loaded.\n" +
    pendingRows.length + " 個待審批提交已載入。\n\n" +
    (dupCount > 0
      ? "⚠️ " + dupCount + " row(s) in RED are possible duplicates — check before approving.\n" +
        "⚠️ " + dupCount + " 行紅色為可能重複 — 批准前請核對。\n\n"
      : "") +
    "Fill in Project No. + Role for each row, then:\n" +
    "  Timesheet ⏱ → ✓ Approve Checked\n" +
    "  Timesheet ⏱ → ✕ Reject Checked"
  );
}

// ─── Approve / Reject Selected ───────────────────────────────
function approveSelected() { _applyStatus_("Approved"); }
function rejectSelected()  { _applyStatus_("Rejected"); }

function _applyStatus_(newStatus) {
  var ss   = SpreadsheetApp.getActiveSpreadsheet();
  var dash = ss.getSheetByName("Dashboard");
  var src  = ss.getSheetByName(SHEET_NAME);

  if (!dash || !src) {
    SpreadsheetApp.getUi().alert(
      "Please run 'Show Pending' first.\n請先執行「顯示待審批」。"
    );
    return;
  }

  var lastRow = dash.getLastRow();
  if (lastRow < 2) {
    SpreadsheetApp.getUi().alert("No data in Dashboard. 儀表板沒有資料。");
    return;
  }

  // Read checkbox (A), row# (B), project no. (I), PIC (J), role (K) from Dashboard
  var dashData = dash.getRange(2, 1, lastRow - 1, 11).getValues();
  var count = 0;
  var missingProjectNo = 0;
  var missingRole = 0;

  // First pass: count warnings (only for Approve)
  if (newStatus === "Approved") {
    for (var w = 0; w < dashData.length; w++) {
      if (dashData[w][0] === true && parseInt(dashData[w][1]) > 1) {
        if (!String(dashData[w][8]).trim()) missingProjectNo++;
        if (!String(dashData[w][10]).trim()) missingRole++;
      }
    }
    // Soft validation: warn but allow override
    if (missingProjectNo > 0 || missingRole > 0) {
      var warnings = [];
      if (missingProjectNo > 0) warnings.push(missingProjectNo + " row(s) missing Project No. 專案編號");
      if (missingRole > 0) warnings.push(missingRole + " row(s) missing Role 角色");
      var proceed = SpreadsheetApp.getUi().alert(
        "Warning 提醒",
        warnings.join("\n") + "\n\nRows without these fields will be skipped during Notion sync.\n缺少這些欄位的行將不會同步到Notion。\n\nProceed anyway? 仍然繼續？",
        SpreadsheetApp.getUi().ButtonSet.YES_NO
      );
      if (proceed === SpreadsheetApp.getUi().Button.NO) return;
    }
  }

  var mismatched = 0;

  for (var i = 0; i < dashData.length; i++) {
    var checked = dashData[i][0];
    var srcRow  = parseInt(dashData[i][1]);
    if (checked === true && srcRow > 1) {
      // Safety guard: the Dashboard stores row NUMBERS, which go stale if the
      // source sheet was sorted or had rows inserted/deleted after Show Pending.
      // Name + phone alone isn't enough — staff have many rows, so after a sort
      // the number can point at ANOTHER job of the same person (even a Paid one).
      // Verify name, phone, date, venue, rate AND that it's still Pending.
      var s = src.getRange(srcRow, 1, 1, 14).getValues()[0];
      var same =
        String(s[1]).trim() === String(dashData[i][2]).trim() &&       // B name
        _normPhone_(s[2]) === _normPhone_(dashData[i][3]) &&             // C phone
        _dateStr_(s[3]) === _dateStr_(dashData[i][4]) &&                 // D date
        String(s[4]).trim() === String(dashData[i][5]).trim() &&       // E venue
        _toNum_(s[5]) === _toNum_(dashData[i][6]) &&                     // F rate
        String(s[13]).trim() === "Pending";                            // N status
      if (!same) {
        mismatched++;
        continue;
      }

      // Update column N (Status) in Timesheet_Submissions
      src.getRange(srcRow, 14).setValue(newStatus);

      // Write Project No. (Dashboard col I) back to Timesheet_Submissions col J
      var projectNo = String(dashData[i][8]).trim();
      if (projectNo) src.getRange(srcRow, 10).setValue(projectNo);

      // Write PIC (Dashboard col J) back to Timesheet_Submissions col K
      var pic = String(dashData[i][9]).trim();
      if (pic) src.getRange(srcRow, 11).setValue(pic);

      // Write Role (Dashboard col K) back to Timesheet_Submissions col O
      var role = String(dashData[i][10]).trim();
      if (role) src.getRange(srcRow, 15).setValue(role);

      // Colour the dashboard row green (approved) or red (rejected)
      dash.getRange(i + 2, 1, 1, 12).setBackground(
        newStatus === "Approved" ? "#D4EDDA" : "#FDDEDE"
      );
      // Uncheck so it can't be double-applied
      dash.getRange(i + 2, 1).setValue(false);
      count++;
    }
  }

  if (mismatched > 0) {
    SpreadsheetApp.getUi().alert(
      "⚠️ " + mismatched + " row(s) SKIPPED — the sheet changed since Show Pending " +
      "(rows were sorted, added or deleted, or the row is no longer Pending).\n" +
      "Run 'Show Pending' again and re-approve those rows.\n\n" +
      "⚠️ " + mismatched + " 行已跳過 — 資料表在「顯示待審批」後有變動（排序／新增／刪除，或該行已不是待審批）。\n" +
      "請重新執行「顯示待審批」再批准。"
    );
  }

  if (count === 0) {
    SpreadsheetApp.getUi().alert(
      "No rows selected. Tick the checkboxes first.\n請先勾選方格。"
    );
  } else {
    SpreadsheetApp.getUi().alert(
      count + " submission(s) marked as " + newStatus + ".\n" +
      count + " 個提交已標記為" + (newStatus === "Approved" ? "批准 ✓" : "拒絕 ✕") + "。"
    );
  }
}

// ─── Month picker (shared by Refresh Payroll & Mark as Paid) ─
// Distinct "YYYY-MM" months among rows whose Status is in `statuses`,
// newest first, with entry counts for the dialog checkboxes.
function _collectMonths_(data, statuses) {
  var counts = {};
  for (var i = 0; i < data.length; i++) {
    var status = String(data[i][13]).trim();
    if (statuses.indexOf(status) === -1) continue;

    var dateOfWork = data[i][3];
    if (dateOfWork instanceof Date) {
      dateOfWork = Utilities.formatDate(dateOfWork, TIMEZONE, "yyyy-MM-dd");
    } else {
      dateOfWork = String(dateOfWork).trim();
    }
    var month = dateOfWork.substring(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) continue;
    counts[month] = (counts[month] || 0) + 1;
  }

  var months = Object.keys(counts).sort().reverse();
  var out = [];
  for (var m = 0; m < months.length; m++) {
    out.push({ month: months[m], count: counts[months[m]] });
  }
  return out;
}

// Empty list = all months included.
function _monthMatches_(dateOfWork, monthList) {
  if (!monthList || monthList.length === 0) return true;
  return monthList.indexOf(String(dateOfWork).substring(0, 7)) !== -1;
}

// The dialog posts back whatever the browser sends — never trust the shape.
function _normMonthList_(monthList) {
  if (!Array.isArray(monthList)) return [];
  var out = [];
  for (var i = 0; i < monthList.length; i++) {
    var m = String(monthList[i]).trim();
    if (/^\d{4}-\d{2}$/.test(m) && out.indexOf(m) === -1) out.push(m);
  }
  return out.sort();
}

// Checkbox dialog: tick 1+ months (or Select all → empty list = all months),
// then calls the named server function with the selected list.
function _showMonthPicker_(dialogTitle, months, callbackFnName) {
  var rows = "";
  for (var i = 0; i < months.length; i++) {
    rows +=
      '<label class="row"><input type="checkbox" class="month" value="' + months[i].month + '">' +
      '<b>' + months[i].month + '</b> <span class="count">(' + months[i].count + ' entries 筆)</span></label>';
  }
  var html =
    '<style>' +
      'body{font-family:Arial,sans-serif;font-size:14px;margin:16px;}' +
      '.row{display:block;padding:7px 4px;border-radius:6px;cursor:pointer;}' +
      '.row:hover{background:#F3F4F6;}' +
      'input[type=checkbox]{transform:scale(1.3);margin-right:10px;vertical-align:middle;}' +
      '.count{color:#6B7280;font-size:12px;}' +
      'hr{border:none;border-top:1px solid #E5E7EB;margin:8px 0;}' +
      '#warn{display:none;color:#DC2626;margin-top:8px;}' +
      '.btns{margin-top:14px;text-align:right;}' +
      'button{font-size:14px;padding:9px 18px;border-radius:6px;border:1px solid #D1D5DB;background:#FFF;cursor:pointer;margin-left:8px;}' +
      '#ok{background:#2563EB;color:#FFF;border-color:#2563EB;font-weight:bold;}' +
    '</style>' +
    '<div>Tick the month(s) to include 請勾選要包含的月份：</div>' +
    '<div style="margin-top:10px;"><label class="row"><input type="checkbox" id="all"><b>Select all 全選</b></label></div>' +
    '<hr>' + rows +
    '<div id="warn">Please tick at least one month. 請至少勾選一個月份。</div>' +
    '<div class="btns"><button id="cancel">Cancel 取消</button><button id="ok">Confirm 確認</button></div>' +
    '<script>' +
      'var all=document.getElementById("all");' +
      'var boxes=Array.prototype.slice.call(document.querySelectorAll(".month"));' +
      'all.onchange=function(){boxes.forEach(function(b){b.checked=all.checked;});};' +
      'boxes.forEach(function(b){b.onchange=function(){if(!b.checked)all.checked=false;};});' +
      // Do NOT close the dialog right after google.script.run — closing kills the
      // pending request before it reaches the server. Keep it open with a
      // "Running…" state and close only from the success handler.
      'document.getElementById("ok").onclick=function(){' +
        'var sel=all.checked?[]:boxes.filter(function(b){return b.checked;}).map(function(b){return b.value;});' +
        'var warn=document.getElementById("warn");' +
        'if(!all.checked&&sel.length===0){warn.style.display="block";return;}' +
        'var ok=document.getElementById("ok"),cancel=document.getElementById("cancel");' +
        'ok.disabled=true;cancel.disabled=true;ok.textContent="Running\\u2026 \\u57f7\\u884c\\u4e2d\\u2026";warn.style.display="none";' +
        'google.script.run' +
          '.withSuccessHandler(function(){google.script.host.close();})' +
          '.withFailureHandler(function(e){' +
            'warn.textContent="Error \\u932f\\u8aa4: "+((e&&e.message)?e.message:e);warn.style.display="block";' +
            'ok.disabled=false;cancel.disabled=false;ok.textContent="Confirm \\u78ba\\u8a8d";' +
          '})' +
          '["' + callbackFnName + '"](sel);' +
      '};' +
      'document.getElementById("cancel").onclick=function(){google.script.host.close();};' +
    '<\/script>';
  var out = HtmlService.createHtmlOutput(html)
    .setWidth(340)
    .setHeight(Math.min(250 + (months.length + 1) * 34, 520));
  SpreadsheetApp.getUi().showModalDialog(out, dialogTitle);
}

// ─── Refresh Payroll → Staff_Directory ──────────────────────
// Step 1: show the month-picker dialog for months found in the data.
// Step 2: the dialog calls runPayrollForMonths(monthList) below.
function refreshPayroll() {
  var ui  = SpreadsheetApp.getUi();
  var ss  = SpreadsheetApp.getActiveSpreadsheet();
  var src = ss.getSheetByName(SHEET_NAME);
  if (!src) {
    ui.alert("Sheet 'Timesheet_Submissions' not found.");
    return;
  }

  var lastRow = src.getLastRow();
  if (lastRow < 2) {
    ui.alert("No submissions found.");
    return;
  }

  var data   = src.getRange(2, 1, lastRow - 1, 16).getValues();
  var months = _collectMonths_(data, ["Approved", "Paid"]);
  if (months.length === 0) {
    ui.alert("No approved or paid submissions found. 沒有已批准或已支付的提交。");
    return;
  }

  _showMonthPicker_("Payroll Months 薪資月份", months, "runPayrollForMonths");
}

// monthList: array of "YYYY-MM" strings; empty array = all months.
function runPayrollForMonths(monthList) {
  monthList = _normMonthList_(monthList);
  var monthLabel = monthList.join(", ");

  var ui  = SpreadsheetApp.getUi();
  var ss  = SpreadsheetApp.getActiveSpreadsheet();
  var src = ss.getSheetByName(SHEET_NAME);
  if (!src) {
    ui.alert("Sheet 'Timesheet_Submissions' not found.");
    return;
  }

  var dir = ss.getSheetByName("Staff_Directory");
  if (!dir) { dir = ss.insertSheet("Staff_Directory"); }

  var lastRow = src.getLastRow();
  if (lastRow < 2) {
    ui.alert("No submissions found.");
    return;
  }

  var data = src.getRange(2, 1, lastRow - 1, 16).getValues();

  // ── Filter to Approved/Paid + optional month, group by canonical phone ──
  var staffMap  = {};
  var phoneOrder = [];

  for (var i = 0; i < data.length; i++) {
    var status = String(data[i][13]).trim();
    if (status !== "Approved" && status !== "Paid") continue;

    var dateOfWork = data[i][3];
    if (dateOfWork instanceof Date) {
      dateOfWork = Utilities.formatDate(dateOfWork, "Asia/Hong_Kong", "yyyy-MM-dd");
    } else {
      dateOfWork = String(dateOfWork).trim();
    }

    // Skip if month isn't in the selected list (empty list = all months)
    if (!_monthMatches_(dateOfWork, monthList)) continue;

    var phone     = _normPhone_(data[i][2]);
    var name      = String(data[i][1]).trim();
    var projectNo = String(data[i][9]).trim();
    var venue     = String(data[i][4]).trim();
    var rate      = _finalRate_(data[i]);

    if (!staffMap[phone]) {
      staffMap[phone] = { names: {}, jobs: [] };
      phoneOrder.push(phone);
    }
    if (name) staffMap[phone].names[name] = true;
    staffMap[phone].jobs.push({
      projectNo: projectNo,
      date:      dateOfWork,
      venue:     venue,
      finalRate: rate.amount,
      bad:       !rate.ok,          // no usable Final Rate — must be fixed, never paid as $0
      srcRow:    i + 2,
      paid:      (status === "Paid")
    });
  }

  // ── Rebuild Staff_Directory ──
  dir.clear();

  var titleFont  = SpreadsheetApp.newTextStyle().setBold(true).setFontSize(12).build();
  var nameFont   = SpreadsheetApp.newTextStyle().setBold(false).setFontSize(10).setItalic(true).build();
  var headerFont = SpreadsheetApp.newTextStyle().setBold(true).setFontSize(10).build();
  var totalFont  = SpreadsheetApp.newTextStyle().setBold(true).setFontSize(10).build();
  var grandFont  = SpreadsheetApp.newTextStyle().setBold(true).setFontSize(12).build();

  // ── Title row showing which month was selected ──
  var titleText = monthLabel
    ? "Payroll — " + monthLabel + "  薪資表"
    : "Payroll — All Months  薪資表（所有月份）";
  dir.getRange(1, 1).setValue(titleText);
  dir.getRange(1, 1, 1, 5).mergeAcross();
  dir.getRange(1, 1)
    .setFontWeight("bold").setFontSize(13)
    .setBackground("#2563EB").setFontColor("#FFFFFF")
    .setHorizontalAlignment("center");

  // Precompute each person's total + unpaid balance (used by the FPS list and detail sections).
  // The unpaid, valid jobs are also saved as the "payment list" that
  // Mark Approved as Paid later checks against.
  var payList  = [];
  var badRows  = [];
  for (var t = 0; t < phoneOrder.length; t++) {
    var sm = staffMap[phoneOrder[t]];
    sm.total = 0;
    sm.toPay = 0;
    sm.badRows = [];
    for (var tj = 0; tj < sm.jobs.length; tj++) {
      var tjob = sm.jobs[tj];
      sm.total += tjob.finalRate;
      if (tjob.paid) continue;
      if (tjob.bad) { sm.badRows.push(tjob.srcRow); badRows.push(tjob.srcRow); continue; }
      sm.toPay += tjob.finalRate;
      payList.push(_payKey_(phoneOrder[t], tjob.date, tjob.venue, tjob.finalRate));
    }
  }

  var row = 2;
  var grandTotal = 0;

  // ── FPS Payment List — one row per person, pay straight down the list ──
  if (phoneOrder.length > 0) {
    dir.getRange(row, 1).setValue("💰 FPS Payment List 轉數快支付清單 — pay each person the TO PAY amount, then run 'Mark Approved as Paid' 每人支付「待支付」金額，然後執行「標記已支付」");
    dir.getRange(row, 1, 1, 5).mergeAcross();
    dir.getRange(row, 1)
      .setFontWeight("bold").setFontSize(11)
      .setBackground("#16A34A").setFontColor("#FFFFFF");
    row++;

    // Column D is what is still OWED — never the lifetime total (for a PARTIAL
    // person that would include jobs already paid)
    var fpsHeaders = ["Staff Name 姓名", "Phone (FPS) 電話", "Jobs 工作數", "TO PAY 待支付 ($)", "Status 狀態"];
    for (var fh = 0; fh < fpsHeaders.length; fh++) {
      dir.getRange(row, fh + 1).setValue(fpsHeaders[fh])
        .setFontWeight("bold").setBackground("#D9D9D9").setHorizontalAlignment("center");
    }
    row++;

    for (var fp = 0; fp < phoneOrder.length; fp++) {
      var fStaff = staffMap[phoneOrder[fp]];
      dir.getRange(row, 1).setValue(Object.keys(fStaff.names).join(" / "));
      dir.getRange(row, 2).setValue(phoneOrder[fp]);
      dir.getRange(row, 3).setValue(fStaff.jobs.length).setHorizontalAlignment("center");
      dir.getRange(row, 4).setValue(fStaff.toPay).setNumberFormat("$#,##0");
      var paidJobs = 0;
      for (var fj = 0; fj < fStaff.jobs.length; fj++) {
        if (fStaff.jobs[fj].paid) paidJobs++;
      }
      var fpsStatus = (paidJobs === fStaff.jobs.length) ? "✓ PAID 已支付"
                    : (paidJobs === 0) ? "TO PAY 待支付"
                    : "PARTIAL — pay TO PAY amount 部分已支付，只付待支付金額";
      if (fStaff.badRows.length > 0) {
        fpsStatus = "⚠️ CHECK row " + fStaff.badRows.join(", ") + " — no Final Rate 缺最終日薪 · " + fpsStatus;
        dir.getRange(row, 1, 1, 5).setBackground("#FDDEDE");
      }
      dir.getRange(row, 5).setValue(fpsStatus).setHorizontalAlignment("center");
      row++;
    }
    row++; // blank separator before per-person detail
  }

  for (var p = 0; p < phoneOrder.length; p++) {
    var phone     = phoneOrder[p];
    var staff     = staffMap[phone];
    var namesUsed = Object.keys(staff.names).join(" / ");

    dir.getRange(row, 1).setValue("📱 " + phone);
    dir.getRange(row, 1, 1, 5).mergeAcross();
    dir.getRange(row, 1).setTextStyle(titleFont);
    row++;

    dir.getRange(row, 1).setValue("Names: " + namesUsed);
    dir.getRange(row, 1, 1, 5).mergeAcross();
    dir.getRange(row, 1).setTextStyle(nameFont);
    row++;

    var headers = ["Project No.", "Date", "Work Venue", "Final Rate ($)", "Status"];
    for (var h = 0; h < headers.length; h++) {
      var cell = dir.getRange(row, h + 1);
      cell.setValue(headers[h]);
      cell.setTextStyle(headerFont);
      cell.setBackground("#D9D9D9");
      cell.setHorizontalAlignment("center");
    }
    row++;

    var personTotal = 0;
    staff.jobs.sort(function(a, b) {
      return (a.date < b.date) ? -1 : (a.date > b.date) ? 1 : 0;
    });

    for (var j = 0; j < staff.jobs.length; j++) {
      var job = staff.jobs[j];
      dir.getRange(row, 1).setValue(job.projectNo);
      dir.getRange(row, 2).setValue(job.date);
      dir.getRange(row, 3).setValue(job.venue);
      dir.getRange(row, 4).setValue(job.finalRate).setNumberFormat("$#,##0");
      dir.getRange(row, 5).setValue(job.paid ? "✓ Paid 已支付"
        : job.bad ? "⚠️ No Final Rate — fix row " + job.srcRow + " 請修正" : "");
      if (job.bad && !job.paid) dir.getRange(row, 1, 1, 5).setBackground("#FDDEDE");
      personTotal += job.finalRate;
      row++;
    }

    dir.getRange(row, 3).setValue("Total Payroll 薪資總計");
    dir.getRange(row, 3).setTextStyle(totalFont).setHorizontalAlignment("right");
    dir.getRange(row, 4).setValue(personTotal).setNumberFormat("$#,##0").setTextStyle(totalFont);
    dir.getRange(row, 3, 1, 2).setBackground("#E8F0FE");
    grandTotal += personTotal;
    row++;
    row++; // blank separator
  }

  var toPayTotal = 0;

  if (phoneOrder.length > 0) {
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
  } else {
    dir.getRange(2, 1).setValue(
      "No approved or paid submissions found" +
      (monthLabel ? " for " + monthLabel : "") +
      ". 沒有已批准或已支付的提交。"
    );
  }

  // ── Auto-fit column widths to content ──
  dir.autoResizeColumns(1, 5);

  // ── Rebuild Job_Summary from the same data (all months, no filter) ──
  _buildJobSummary_(ss, data);

  // ── Remember exactly what this list asks accounting to pay ──
  _savePaySnapshot_({
    at:    Utilities.formatDate(new Date(), TIMEZONE, "yyyy-MM-dd HH:mm"),
    total: toPayTotal,
    keys:  payList
  });

  ui.alert(
    "Payroll refreshed! 薪資表已更新！\n" +
    (monthLabel ? "Months: " + monthLabel + "\n" : "All months included.\n") +
    phoneOrder.length + " staff. To pay: $" + toPayTotal +
    " · Already paid: $" + (grandTotal - toPayTotal) + "\n" +
    phoneOrder.length + " 位員工。待支付：$" + toPayTotal +
    " · 已支付：$" + (grandTotal - toPayTotal) + "\n\n" +
    (badRows.length > 0
      ? "⚠️ " + badRows.length + " approved job(s) have no valid Final Rate (column M) and are NOT in To Pay — " +
        "fix row(s) " + badRows.join(", ") + " in Timesheet_Submissions, then Refresh Payroll again.\n" +
        "⚠️ " + badRows.length + " 個已批准工作沒有有效的最終日薪（M欄），未計入待支付 — 請修正第 " +
        badRows.join(", ") + " 行後再更新薪資表。\n\n"
      : "") +
    "Job_Summary tab also updated (all months).\n" +
    "Job_Summary 分頁亦已更新（所有月份）。"
  );

  // ── Sync to Notion (ask first — payroll refresh alone shouldn't write to Notion) ──
  if (phoneOrder.length > 0) {
    var syncAns = ui.alert(
      "Sync to Notion? 同步到Notion？",
      "Also sync approved rows to Notion HR now?\n" +
      "(Rows already synced are skipped automatically.)\n\n" +
      "是否現在將已批准的紀錄同步到Notion？\n（已同步的紀錄會自動略過。）",
      ui.ButtonSet.YES_NO
    );
    if (syncAns === ui.Button.YES) {
      syncMonthlyToNotion_(monthList);
      ui.alert(
        "Notion sync finished. Check the Sync_Log tab for details.\n" +
        "Notion同步完成，詳情請查看 Sync_Log 分頁。"
      );
    }
  }
}

// ─── Job Summary → Job_Summary (rebuilt by refreshPayroll) ──
// One calendar-style grid per project: staff rows × work-date columns,
// each cell = that person's Final Rate for that day. Approved + Paid rows,
// all months (ignores the payroll month filter). Sorted by project number;
// rows without a Project No. grouped in a final section.
function _buildJobSummary_(ss, data) {
  var tab = ss.getSheetByName("Job_Summary");
  if (!tab) { tab = ss.insertSheet("Job_Summary"); }
  tab.clear();

  var NO_PROJECT = "(No Project No. 未填項目編號)";

  // ── Group Approved/Paid rows by project ──
  var projMap = {};
  for (var i = 0; i < data.length; i++) {
    var status = String(data[i][13]).trim();
    if (status !== "Approved" && status !== "Paid") continue;

    var dateOfWork = data[i][3];
    if (dateOfWork instanceof Date) {
      dateOfWork = Utilities.formatDate(dateOfWork, TIMEZONE, "yyyy-MM-dd");
    } else {
      dateOfWork = String(dateOfWork).trim();
    }

    var projectNo = String(data[i][9]).trim() || NO_PROJECT;
    var phone     = _normPhone_(data[i][2]);
    var name      = String(data[i][1]).trim();
    var venue     = String(data[i][4]).trim();
    var finalRate = _finalRate_(data[i]).amount;

    if (!projMap[projectNo]) {
      projMap[projectNo] = { venues: {}, dates: {}, staff: {} };
    }
    var proj = projMap[projectNo];
    if (venue) proj.venues[venue] = true;
    proj.dates[dateOfWork] = true;

    if (!proj.staff[phone]) proj.staff[phone] = { names: {}, byDate: {} };
    if (name) proj.staff[phone].names[name] = true;
    proj.staff[phone].byDate[dateOfWork] = (proj.staff[phone].byDate[dateOfWork] || 0) + finalRate;
  }

  // ── Sort projects by number, "(No Project No.)" last ──
  var projectNos = Object.keys(projMap).sort(function(a, b) {
    if (a === NO_PROJECT) return 1;
    if (b === NO_PROJECT) return -1;
    return a.localeCompare(b, undefined, { numeric: true });
  });

  var titleFont  = SpreadsheetApp.newTextStyle().setBold(true).setFontSize(12).build();
  var headerFont = SpreadsheetApp.newTextStyle().setBold(true).setFontSize(10).build();
  var totalFont  = SpreadsheetApp.newTextStyle().setBold(true).setFontSize(10).build();
  var grandFont  = SpreadsheetApp.newTextStyle().setBold(true).setFontSize(12).build();
  var venueFont  = SpreadsheetApp.newTextStyle().setItalic(true).setFontSize(9)
    .setForegroundColor("#6B7280").build();

  // ── Title row ──
  var maxCols = 5;
  for (var m = 0; m < projectNos.length; m++) {
    var w = Object.keys(projMap[projectNos[m]].dates).length + 2;
    if (w > maxCols) maxCols = w;
  }
  tab.getRange(1, 1).setValue("Job Summary — All Months  工作項目摘要（所有月份）");
  tab.getRange(1, 1, 1, maxCols).mergeAcross();
  tab.getRange(1, 1)
    .setFontWeight("bold").setFontSize(13)
    .setBackground("#7C3AED").setFontColor("#FFFFFF")
    .setHorizontalAlignment("center");

  if (projectNos.length === 0) {
    tab.getRange(2, 1).setValue(
      "No approved submissions found. 沒有已批准的提交。"
    );
    tab.autoResizeColumns(1, maxCols);
    return;
  }

  var row = 3;
  var grandTotal = 0;

  for (var p = 0; p < projectNos.length; p++) {
    var projectNo = projectNos[p];
    var proj      = projMap[projectNo];
    var dates     = Object.keys(proj.dates).sort();
    var gridCols  = dates.length + 2; // staff col + date cols + total col

    // ── Section header: project number only (venues go on their own line —
    //     a 10-venue list in this cell would dictate the column width) ──
    var venues = Object.keys(proj.venues).join(" / ");
    var headerText = (projectNo === NO_PROJECT)
      ? "📋 " + NO_PROJECT
      : "📋 Project " + projectNo;
    tab.getRange(row, 1).setValue(headerText);
    tab.getRange(row, 1, 1, gridCols).mergeAcross();
    tab.getRange(row, 1).setTextStyle(titleFont);
    row++;

    if (venues) {
      tab.getRange(row, 1).setValue("Venues 場地: " + venues);
      tab.getRange(row, 1, 1, gridCols).mergeAcross();
      tab.getRange(row, 1).setTextStyle(venueFont)
        .setWrapStrategy(SpreadsheetApp.WrapStrategy.WRAP);
      row++;
    }

    var gridTop = row;

    // ── Grid header: Staff | date... | Total ──
    var gridHeaders = ["Staff 姓名"].concat(dates).concat(["Total 總計 ($)"]);
    for (var h = 0; h < gridHeaders.length; h++) {
      tab.getRange(row, h + 1).setValue(gridHeaders[h])
        .setTextStyle(headerFont)
        .setBackground("#D9D9D9")
        .setHorizontalAlignment("center");
    }
    row++;

    // ── Staff rows, sorted by display name ──
    var phones = Object.keys(proj.staff).sort(function(a, b) {
      var an = Object.keys(proj.staff[a].names).join(" / ");
      var bn = Object.keys(proj.staff[b].names).join(" / ");
      return an.localeCompare(bn);
    });

    var dayTotals    = {};
    var projectTotal = 0;

    for (var s = 0; s < phones.length; s++) {
      var staff = proj.staff[phones[s]];
      tab.getRange(row, 1).setValue(Object.keys(staff.names).join(" / "));

      var staffTotal = 0;
      for (var d = 0; d < dates.length; d++) {
        var amt = staff.byDate[dates[d]];
        if (amt !== undefined) {
          tab.getRange(row, d + 2).setValue(amt).setNumberFormat("$#,##0");
          staffTotal += amt;
          dayTotals[dates[d]] = (dayTotals[dates[d]] || 0) + amt;
        }
      }
      tab.getRange(row, gridCols).setValue(staffTotal)
        .setNumberFormat("$#,##0").setTextStyle(totalFont);
      projectTotal += staffTotal;
      row++;
    }

    // ── Day Total row + project total in the corner ──
    tab.getRange(row, 1).setValue("Day Total 每日總計")
      .setTextStyle(totalFont).setHorizontalAlignment("right");
    for (var dt = 0; dt < dates.length; dt++) {
      tab.getRange(row, dt + 2).setValue(dayTotals[dates[dt]] || 0)
        .setNumberFormat("$#,##0").setTextStyle(totalFont);
    }
    tab.getRange(row, gridCols).setValue(projectTotal)
      .setNumberFormat("$#,##0").setTextStyle(totalFont);
    tab.getRange(row, 1, 1, gridCols).setBackground("#E8F0FE");
    tab.getRange(gridTop, 1, row - gridTop + 1, gridCols)
      .setBorder(true, true, true, true, true, true, "#D1D5DB", SpreadsheetApp.BorderStyle.SOLID);
    grandTotal += projectTotal;
    row++;
    row++; // blank separator
  }

  // ── Grand total across all jobs (label spans 4 narrow columns) ──
  tab.getRange(row, 1).setValue("GRAND TOTAL (all jobs) 所有項目總計");
  tab.getRange(row, 1, 1, 4).mergeAcross();
  tab.getRange(row, 1).setTextStyle(grandFont).setHorizontalAlignment("right");
  tab.getRange(row, 5).setValue(grandTotal)
    .setNumberFormat("$#,##0").setTextStyle(grandFont);
  tab.getRange(row, 1, 1, 5).setBackground("#C6DAFC");

  // Fixed pixel widths — autoResizeColumns would stretch column A to fit the
  // longest header line instead of the staff names.
  tab.setColumnWidth(1, 170);
  if (maxCols > 1) tab.setColumnWidths(2, maxCols - 1, 95);
}

// ─── Payment list memory (Refresh Payroll → Mark Approved as Paid) ─
// Mark as Paid may only flip jobs that accounting was actually shown as TO PAY.
// Each Refresh Payroll ADDS its To-Pay jobs (a refresh for another month must
// not forget an unpaid list); Mark as Paid removes the jobs it marks.
// Jobs are matched by content, not row number, so sorting the sheet is safe.
// Stored in Document Properties, split into chunks (9 KB per value limit).
var PAY_SNAP_PREFIX = "PAY_SNAP_";

function _payKey_(phone, date, venue, amount) {
  return phone + "|" + date + "|" + amount + "|" + venue;
}

function _rowPayKey_(row) {
  return _payKey_(_normPhone_(row[2]), _dateStr_(row[3]), String(row[4]).trim(), _finalRate_(row).amount);
}

function _loadPaySnapshot_() {
  var props = PropertiesService.getDocumentProperties();
  var n = parseInt(props.getProperty(PAY_SNAP_PREFIX + "N") || "0", 10);
  if (!n) return null;
  var s = "";
  for (var i = 0; i < n; i++) s += props.getProperty(PAY_SNAP_PREFIX + i) || "";
  try { return JSON.parse(s); } catch (e) { return null; }
}

function _writePaySnapshot_(snap) {
  var props = PropertiesService.getDocumentProperties();
  var old = parseInt(props.getProperty(PAY_SNAP_PREFIX + "N") || "0", 10);
  var s = JSON.stringify(snap);
  var CHUNK = 2500; // ≤ 9 KB even if every character is 3-byte Chinese
  var n = Math.max(1, Math.ceil(s.length / CHUNK));
  for (var i = 0; i < n; i++) props.setProperty(PAY_SNAP_PREFIX + i, s.substring(i * CHUNK, (i + 1) * CHUNK));
  for (var j = n; j < old; j++) props.deleteProperty(PAY_SNAP_PREFIX + j);
  props.setProperty(PAY_SNAP_PREFIX + "N", String(n));
}

// list: array of pay keys from this refresh (may repeat for identical jobs)
function _savePaySnapshot_(info) {
  var snap = _loadPaySnapshot_() || { counts: {} };
  var fresh = {};
  for (var i = 0; i < info.keys.length; i++) fresh[info.keys[i]] = (fresh[info.keys[i]] || 0) + 1;
  for (var k in fresh) {
    if (!snap.counts[k] || snap.counts[k] < fresh[k]) snap.counts[k] = fresh[k];
  }
  snap.at = info.at;
  snap.total = info.total;
  _writePaySnapshot_(snap);
}

// ─── Mark Approved as Paid (for accounting, after FPS payout) ─
// Step 1: show the month-picker dialog for months with Approved rows.
// Step 2: the dialog calls runMarkPaidForMonths(monthList) below.
function markApprovedAsPaid() {
  var ui  = SpreadsheetApp.getUi();
  var ss  = SpreadsheetApp.getActiveSpreadsheet();
  var src = ss.getSheetByName(SHEET_NAME);
  if (!src) {
    ui.alert("Sheet 'Timesheet_Submissions' not found.");
    return;
  }

  var lastRow = src.getLastRow();
  if (lastRow < 2) {
    ui.alert("No submissions found. 沒有提交紀錄。");
    return;
  }

  var data   = src.getRange(2, 1, lastRow - 1, 16).getValues();
  var months = _collectMonths_(data, ["Approved"]);
  if (months.length === 0) {
    ui.alert("No approved submissions found. 沒有已批准的提交。");
    return;
  }

  _showMonthPicker_("Mark as Paid 標記已支付", months, "runMarkPaidForMonths");
}

// monthList: array of "YYYY-MM" strings; empty array = all months.
function runMarkPaidForMonths(monthList) {
  monthList = _normMonthList_(monthList);
  var monthLabel = monthList.join(", ");

  var ui  = SpreadsheetApp.getUi();
  var ss  = SpreadsheetApp.getActiveSpreadsheet();
  var src = ss.getSheetByName(SHEET_NAME);
  if (!src) {
    ui.alert("Sheet 'Timesheet_Submissions' not found.");
    return;
  }

  var lastRow = src.getLastRow();
  if (lastRow < 2) {
    ui.alert("No submissions found. 沒有提交紀錄。");
    return;
  }

  var data = src.getRange(2, 1, lastRow - 1, 16).getValues();

  // Only jobs that a Refresh Payroll showed as TO PAY may be marked Paid —
  // anything approved after the list was made has not been paid yet.
  var snap = _loadPaySnapshot_();
  if (!snap) {
    ui.alert(
      "Run 'Refresh Payroll' first, pay from that list, then mark as paid.\n" +
      "請先執行「更新薪資表」，按清單支付後再標記已支付。"
    );
    return;
  }
  var remaining = {};
  for (var k in snap.counts) remaining[k] = snap.counts[k];

  var targetRows = [];
  var total = 0;
  var unsynced = 0;
  var notListed = 0;
  var notListedTotal = 0;

  for (var i = 0; i < data.length; i++) {
    if (String(data[i][13]).trim() !== "Approved") continue;
    if (!_monthMatches_(_dateStr_(data[i][3]), monthList)) continue;

    var key = _rowPayKey_(data[i]);
    var amount = _finalRate_(data[i]).amount;
    if (!remaining[key]) {          // not on any payment list (or no valid Final Rate)
      notListed++;
      notListedTotal += amount;
      continue;
    }
    remaining[key]--;
    targetRows.push({ row: i + 2, key: key });
    total += amount;
    if (!String(data[i][15]).trim()) unsynced++;
  }

  var notListedMsg = notListed > 0
    ? "⚠️ " + notListed + " approved job(s) ($" + notListedTotal + ") were NOT on the payment list " +
      "(approved after the last Refresh Payroll, or missing a Final Rate). They stay Approved — " +
      "run Refresh Payroll, pay them, then mark again.\n" +
      "⚠️ " + notListed + " 個已批准工作（$" + notListedTotal + "）不在支付清單上（於上次更新薪資表後才批准，或缺最終日薪），" +
      "會保持「已批准」— 請重新更新薪資表、支付後再標記。"
    : "";

  if (targetRows.length === 0) {
    ui.alert(
      "No approved submissions on the payment list" + (monthLabel ? " for " + monthLabel : "") + ".\n" +
      "支付清單上沒有已批准的提交" + (monthLabel ? "（" + monthLabel + "）" : "") + "。" +
      (notListedMsg ? "\n\n" + notListedMsg : "")
    );
    return;
  }

  var confirm = ui.alert(
    "Confirm Payment 確認支付",
    targetRows.length + " approved submission(s), total $" + total +
    ", will be marked as PAID.\n" +
    (monthLabel ? "Months: " + monthLabel : "All months.") + "\n" +
    "Last payment list: " + snap.at + " (To Pay $" + snap.total + ").\n" +
    "上次支付清單：" + snap.at + "（待支付 $" + snap.total + "）。" +
    (notListedMsg ? "\n\n" + notListedMsg : "") +
    (unsynced > 0
      ? "\n\n(" + unsynced + " of these not yet synced to Notion — they will still sync later.)"
      : "") +
    "\n\n" + targetRows.length + " 個已批准提交（共 $" + total + "）將標記為已支付。\n\n" +
    "Proceed? 確認繼續？",
    ui.ButtonSet.YES_NO
  );
  if (confirm !== ui.Button.YES) return;

  for (var r = 0; r < targetRows.length; r++) {
    src.getRange(targetRows[r].row, 14).setValue("Paid");
    snap.counts[targetRows[r].key]--;
    if (snap.counts[targetRows[r].key] <= 0) delete snap.counts[targetRows[r].key];
  }
  _writePaySnapshot_(snap);

  ui.alert(
    "✓ " + targetRows.length + " submission(s) marked as Paid ($" + total + ").\n" +
    "✓ " + targetRows.length + " 個提交已標記為已支付（共 $" + total + "）。"
  );
}

// ─── Utilities ──────────────────────────────────────────────
function _jsonResponse_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ════════════════════════════════════════════════════════════
//  NOTION SYNC MODULE — Google Sheets → Notion (one-way)
//  Syncs approved timesheet rows to Crew DB + Hiring Posts
// ════════════════════════════════════════════════════════════

var CREW_DB_ID    = "46a7361a-a495-4046-86dc-cf08df33d452";
var HIRING_DB_ID  = "ca055a94-8347-491d-b1e6-ef2188f9eb60";
var NOTION_VERSION = "2022-06-28";

// ─── Notion API Wrapper ─────────────────────────────────────
function notionApiCall_(endpoint, method, payload) {
  var apiKey = PropertiesService.getScriptProperties().getProperty("NOTION_API_KEY");
  if (!apiKey) throw new Error("NOTION_API_KEY not set in Script Properties");

  var url = "https://api.notion.com/v1/" + endpoint;
  var options = {
    method: method || "get",
    headers: {
      "Authorization": "Bearer " + apiKey,
      "Content-Type": "application/json",
      "Notion-Version": NOTION_VERSION
    },
    muteHttpExceptions: true
  };
  if (payload) options.payload = JSON.stringify(payload);

  var response = UrlFetchApp.fetch(url, options);
  var code = response.getResponseCode();

  // Rate limit: wait and retry once
  if (code === 429) {
    Utilities.sleep(5000);
    response = UrlFetchApp.fetch(url, options);
    code = response.getResponseCode();
  }

  Utilities.sleep(400); // Stay under 3 req/sec

  if (code < 200 || code >= 300) {
    throw new Error("Notion API " + code + ": " + response.getContentText().substring(0, 200));
  }

  return JSON.parse(response.getContentText());
}

// ─── Query a Notion Database ────────────────────────────────
function queryNotionDB_(databaseId, filterPayload) {
  return notionApiCall_("databases/" + databaseId + "/query", "post", filterPayload || {});
}

// ─── Create a Notion Page ───────────────────────────────────
function createNotionPage_(databaseId, properties) {
  return notionApiCall_("pages", "post", {
    parent: { database_id: databaseId },
    properties: properties
  });
}

// ─── Update a Notion Page ───────────────────────────────────
function updateNotionPage_(pageId, properties) {
  return notionApiCall_("pages/" + pageId, "patch", { properties: properties });
}

// ─── Get a Notion Page ──────────────────────────────────────
function getNotionPage_(pageId) {
  return notionApiCall_("pages/" + pageId, "get");
}

// ─── Find Crew by Phone Number ──────────────────────────────
function findCrewByPhone_(phone) {
  var result = queryNotionDB_(CREW_DB_ID, {
    filter: {
      property: "Phone 電話",
      phone_number: { equals: phone }
    }
  });

  // Legacy fallback: older Crew entries may have the phone stored as "XXXX XXXX"
  if ((!result.results || result.results.length === 0) && /^\d{8}$/.test(phone)) {
    result = queryNotionDB_(CREW_DB_ID, {
      filter: { property: "Phone 電話", phone_number: { equals: phone.slice(0, 4) + " " + phone.slice(4) } }
    });
  }

  if (!result.results || result.results.length === 0) {
    return { found: false };
  }

  var page = result.results[0];
  var props = page.properties;

  // Read existing Work Log text
  var workLog = "";
  if (props["Work Log 工作記錄"] && props["Work Log 工作記錄"].rich_text && props["Work Log 工作記錄"].rich_text.length > 0) {
    workLog = props["Work Log 工作記錄"].rich_text[0].plain_text;
  }

  // Read existing relation IDs
  var existingRelations = [];
  if (props["Jobs Assigned 派工記錄"] && props["Jobs Assigned 派工記錄"].relation) {
    for (var r = 0; r < props["Jobs Assigned 派工記錄"].relation.length; r++) {
      existingRelations.push(props["Jobs Assigned 派工記錄"].relation[r].id);
    }
  }

  return {
    found: true,
    pageId: page.id,
    workLog: workLog,
    existingRelations: existingRelations
  };
}

// ─── Find Hiring Post by Project No. + Role Type ────────────
function findHiringPost_(projectNo, roleType) {
  var result = queryNotionDB_(HIRING_DB_ID, {
    filter: {
      and: [
        { property: "Project No. 專案編號", rich_text: { equals: projectNo } },
        { property: "Role Type", select: { equals: roleType } }
      ]
    }
  });

  if (!result.results || result.results.length === 0) {
    return { found: false, matchCount: 0 };
  }

  var page = result.results[0];
  var props = page.properties;

  // Extract Client/Mall
  var clientMall = "";
  if (props["Client / Mall"] && props["Client / Mall"].select) {
    clientMall = props["Client / Mall"].select.name;
  }

  // Extract Job Title
  var jobTitle = "";
  if (props["Job Title"] && props["Job Title"].title && props["Job Title"].title.length > 0) {
    jobTitle = props["Job Title"].title[0].plain_text;
  }

  return {
    found: true,
    pageId: page.id,
    clientMall: clientMall,
    jobTitle: jobTitle,
    matchCount: result.results.length
  };
}

// ─── Create Minimal Crew Entry ──────────────────────────────
function createCrewEntry_(name, phone) {
  var page = createNotionPage_(CREW_DB_ID, {
    "Name 姓名": {
      title: [{ text: { content: name } }]
    },
    "Phone 電話": {
      phone_number: phone
    },
    "Status 狀態": {
      select: { name: "Active" }
    }
  });
  return page.id;
}

// ─── Link Crew to Hiring Post (append relation) ─────────────
function linkCrewToHiringPost_(crewPageId, hiringPostPageId, existingRelationIds) {
  // CRITICAL: Notion replaces entire relation array — must include all existing + new
  var relationArray = [];
  for (var i = 0; i < existingRelationIds.length; i++) {
    relationArray.push({ id: existingRelationIds[i] });
  }
  // Only add if not already linked
  var alreadyLinked = false;
  for (var j = 0; j < existingRelationIds.length; j++) {
    if (existingRelationIds[j] === hiringPostPageId) { alreadyLinked = true; break; }
  }
  if (!alreadyLinked) {
    relationArray.push({ id: hiringPostPageId });
  }

  updateNotionPage_(crewPageId, {
    "Jobs Assigned 派工記錄": { relation: relationArray }
  });
}

// ─── Append to Crew Work Log ────────────────────────────────
function appendWorkLog_(crewPageId, existingLog, newEntry) {
  var updatedLog = existingLog ? (existingLog + "\n" + newEntry) : newEntry;
  updateNotionPage_(crewPageId, {
    "Work Log 工作記錄": {
      rich_text: [{ text: { content: updatedLog } }]
    }
  });
}

// ─── Log to Sync_Log Tab ────────────────────────────────────
function logSync_(syncLogSheet, row, staffName, projectNo, role, type, message) {
  var hkt = Utilities.formatDate(new Date(), "Asia/Hong_Kong", "yyyy-MM-dd HH:mm:ss");
  syncLogSheet.appendRow([
    hkt,
    row || "",
    staffName || "",
    projectNo || "",
    role || "",
    type,
    message
  ]);
}

// ─── Get or Create Sync_Log Tab ─────────────────────────────
function _getSyncLogSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("Sync_Log");
  if (!sheet) {
    sheet = ss.insertSheet("Sync_Log");
    var headers = ["Timestamp", "Row", "Staff Name", "Project No.", "Role", "Type", "Message"];
    var headerRange = sheet.getRange(1, 1, 1, headers.length);
    headerRange.setValues([headers]);
    headerRange.setBackground("#2563EB");
    headerRange.setFontColor("#FFFFFF");
    headerRange.setFontWeight("bold");
  }
  return sheet;
}

// ─── MAIN: Sync Monthly to Notion ───────────────────────────
// monthList: array of "YYYY-MM" strings; empty array = all months.
function syncMonthlyToNotion_(monthList) {
  monthList = _normMonthList_(monthList);
  var syncLog = _getSyncLogSheet_();

  // Check API key first
  var apiKey = PropertiesService.getScriptProperties().getProperty("NOTION_API_KEY");
  if (!apiKey) {
    logSync_(syncLog, "", "", "", "", "ERROR", "NOTION_API_KEY not set. Sync aborted.");
    return;
  }

  var ss  = SpreadsheetApp.getActiveSpreadsheet();
  var src = ss.getSheetByName(SHEET_NAME);
  if (!src) {
    logSync_(syncLog, "", "", "", "", "ERROR", "Timesheet_Submissions sheet not found.");
    return;
  }

  var lastRow = src.getLastRow();
  if (lastRow < 2) return;

  var data = src.getRange(2, 1, lastRow - 1, 16).getValues();

  var synced = 0, warnings = 0, errors = 0;

  for (var i = 0; i < data.length; i++) {
    var srcRow = i + 2;
    var status = String(data[i][13]).trim();          // N: Status
    var syncedStamp = String(data[i][15]).trim();      // P: Synced
    var dateOfWork = data[i][3];

    // Only process Approved/Paid rows without a Synced timestamp
    // (Paid included so rows marked Paid before a sync still reach Notion)
    if ((status !== "Approved" && status !== "Paid") || syncedStamp) continue;

    // Filter by month if specified
    if (dateOfWork instanceof Date) {
      dateOfWork = Utilities.formatDate(dateOfWork, "Asia/Hong_Kong", "yyyy-MM-dd");
    } else {
      dateOfWork = String(dateOfWork).trim();
    }
    if (!_monthMatches_(dateOfWork, monthList)) continue;

    var staffName = String(data[i][1]).trim();         // B: Staff Name
    var phone     = _normPhone_(data[i][2]);            // C: Phone (canonical, digits only)
    var projectNo = String(data[i][9]).trim();         // J: Project No.
    var rate      = _finalRate_(data[i]).amount;        // M: Final Rate (basic + OT; F+L if M is broken)
    var role      = String(data[i][14]).trim();        // O: Role

    // ── Validate ──
    if (!phone) {
      logSync_(syncLog, srcRow, staffName, projectNo, role, "WARNING", "Missing phone number, skipped");
      warnings++;
      continue;
    }
    if (!projectNo) {
      logSync_(syncLog, srcRow, staffName, "", role, "WARNING", "Missing Project No., skipped");
      warnings++;
      continue;
    }
    if (!role) {
      logSync_(syncLog, srcRow, staffName, projectNo, "", "WARNING", "Missing Role, skipped");
      warnings++;
      continue;
    }

    try {
      // ── Find or Create Crew ──
      var crew = findCrewByPhone_(phone);
      var crewPageId;
      var existingLog = "";
      var existingRelations = [];

      if (!crew.found) {
        crewPageId = createCrewEntry_(staffName, phone);
        logSync_(syncLog, srcRow, staffName, projectNo, role, "INFO", "New Crew created: " + staffName + " " + phone);
      } else {
        crewPageId = crew.pageId;
        existingLog = crew.workLog;
        existingRelations = crew.existingRelations;
        logSync_(syncLog, srcRow, staffName, projectNo, role, "INFO", "Existing Crew found: " + staffName);
      }

      // ── Find Hiring Post ──
      var hp = findHiringPost_(projectNo, role);
      if (!hp.found) {
        logSync_(syncLog, srcRow, staffName, projectNo, role, "WARNING", "No Hiring Post found for " + projectNo + " + " + role);
        warnings++;
        // Still stamp as synced so we don't retry every month
        var hkt = Utilities.formatDate(new Date(), "Asia/Hong_Kong", "yyyy-MM-dd HH:mm:ss") + " (HKT)";
        src.getRange(srcRow, 16).setValue(hkt);
        continue;
      }
      if (hp.matchCount > 1) {
        logSync_(syncLog, srcRow, staffName, projectNo, role, "INFO", "Multiple Hiring Posts match, using first: " + hp.jobTitle);
      }

      // ── Link Crew to Hiring Post ──
      linkCrewToHiringPost_(crewPageId, hp.pageId, existingRelations);

      // ── Append Work Log ──
      var rateStr = "$" + rate + "/day";
      var workLogEntry = dateOfWork.substring(0, 7) + " │ " + (hp.clientMall || "—") + " │ " + projectNo + " │ " + rateStr;
      appendWorkLog_(crewPageId, existingLog, workLogEntry);

      logSync_(syncLog, srcRow, staffName, projectNo, role, "INFO", "Linked " + staffName + " → " + hp.jobTitle);
      synced++;

      // ── Stamp Synced ──
      var hktStamp = Utilities.formatDate(new Date(), "Asia/Hong_Kong", "yyyy-MM-dd HH:mm:ss") + " (HKT)";
      src.getRange(srcRow, 16).setValue(hktStamp);

    } catch (err) {
      logSync_(syncLog, srcRow, staffName, projectNo, role, "ERROR", err.toString().substring(0, 200));
      errors++;
    }
  }

  // ── Summary ──
  logSync_(syncLog, "", "", "", "", "INFO",
    "Sync complete: " + synced + " synced, " + warnings + " warnings, " + errors + " errors");
}
