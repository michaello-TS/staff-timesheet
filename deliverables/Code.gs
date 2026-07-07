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

// ─── doGet — Health Check ───────────────────────────────────
function doGet(e) {
  return HtmlService.createHtmlOutput(
    "<h2>Timesheet API is running. 工作紀錄系統運作中。</h2>"
  );
}

// ─── doPost — Main Entry Point ──────────────────────────────
function doPost(e) {
  try {
    var payload = JSON.parse(e.postData.contents);
    var action  = payload.action;

    if (!_checkAccessCode(payload)) {
      return _jsonResponse({ status: "error", message: "Invalid access code. 存取碼不正確。" });
    }

    if (action === "submit") {
      return _jsonResponse(handleSubmit(payload));
    } else if (action === "status") {
      return _jsonResponse(handleStatus(payload));
    } else {
      return _jsonResponse({ status: "error", message: "Unknown action: " + action });
    }

  } catch (err) {
    Logger.log("doPost error: " + err.toString());
    return _jsonResponse({ status: "error", message: err.toString() });
  }
}

// ─── Action: Submit Timesheet ───────────────────────────────
function handleSubmit(payload) {
  var entries = payload.entries;
  if (!entries || !entries.length) {
    return { status: "error", message: "No entries provided." };
  }

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
        var prevPhone = _normPhone(prev[k][0]);
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
      var dupKey = _normPhone(entry.phoneNumber) + "|" + String(entry.dateOfWork || "").trim();
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
        _normPhone(entry.phoneNumber),    // C: Phone Number (canonical, digits only)
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
  _notifyPM(entries);

  return { status: "success", rowsAdded: rowsAdded, duplicates: dupIndexes };
}

// ─── Action: Check Staff Submission Status ───────────────────
function handleStatus(payload) {
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
    if (_normPhone(data[i][2]) === _normPhone(phone)) {
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
        startTime:  (st instanceof Date) ? Utilities.formatDate(st, TIMEZONE, "HH:mm") : String(st).trim(),
        endTime:    (et instanceof Date) ? Utilities.formatDate(et, TIMEZONE, "HH:mm") : String(et).trim(),
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
function _notifyPM(entries) {
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

  // ── Header row ──
  var headers = ["✓", "Row#", "Staff Name 姓名", "Phone 電話", "Date 日期", "Venue 地點", "Rate $ 日薪", "Hours 時間", "Project No. 專案編號", "PIC 工作負責人", "Role 角色"];
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
    var startTime = (d[6] instanceof Date) ? Utilities.formatDate(d[6], TIMEZONE, "HH:mm") : String(d[6]).trim();
    var endTime   = (d[7] instanceof Date) ? Utilities.formatDate(d[7], TIMEZONE, "HH:mm") : String(d[7]).trim();
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

    // Alternating row shade
    if (r % 2 === 1) {
      dash.getRange(rowNum, 1, 1, 11).setBackground("#F0F4FF");
    }
  }

  ss.setActiveSheet(dash);
  SpreadsheetApp.getUi().alert(
    pendingRows.length + " pending submission(s) loaded.\n" +
    pendingRows.length + " 個待審批提交已載入。\n\n" +
    "Fill in Project No. + Role for each row, then:\n" +
    "  Timesheet ⏱ → ✓ Approve Checked\n" +
    "  Timesheet ⏱ → ✕ Reject Checked"
  );
}

// ─── Approve / Reject Selected ───────────────────────────────
function approveSelected() { _applyStatus("Approved"); }
function rejectSelected()  { _applyStatus("Rejected"); }

function _applyStatus(newStatus) {
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
      // Verify name + phone still match before touching the row.
      var srcCheck  = src.getRange(srcRow, 2, 1, 2).getValues()[0];
      var srcName   = String(srcCheck[0]).trim();
      var srcPhone  = String(srcCheck[1]).trim();
      var dashName  = String(dashData[i][2]).trim();
      var dashPhone = String(dashData[i][3]).trim();
      if (srcName !== dashName || srcPhone !== dashPhone) {
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
      dash.getRange(i + 2, 1, 1, 11).setBackground(
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
      "(rows were sorted, added or deleted).\n" +
      "Run 'Show Pending' again and re-approve those rows.\n\n" +
      "⚠️ " + mismatched + " 行已跳過 — 資料表在「顯示待審批」後有變動（排序／新增／刪除）。\n" +
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

// ─── Refresh Payroll → Staff_Directory ──────────────────────
function refreshPayroll() {
  var ui = SpreadsheetApp.getUi();

  // ── Ask for month ──
  var result = ui.prompt(
    "Payroll Month 薪資月份",
    "Enter month as YYYY-MM (e.g. 2026-03),\nor leave blank to include all months:\n\n" +
    "請輸入月份 YYYY-MM（如 2026-03）\n或留空以包含所有月份：",
    ui.ButtonSet.OK_CANCEL
  );
  if (result.getSelectedButton() === ui.Button.CANCEL) return;

  var monthFilter = result.getResponseText().trim();
  if (monthFilter && !/^\d{4}-\d{2}$/.test(monthFilter)) {
    ui.alert(
      "Invalid format. Please use YYYY-MM (e.g. 2026-03).\n" +
      "格式錯誤，請使用 YYYY-MM（如 2026-03）。"
    );
    return;
  }

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

    // Skip if month doesn't match the filter
    if (monthFilter && dateOfWork.indexOf(monthFilter) !== 0) continue;

    var phone     = _normPhone(data[i][2]);
    var name      = String(data[i][1]).trim();
    var projectNo = String(data[i][9]).trim();
    var venue     = String(data[i][4]).trim();
    var finalRate = data[i][12];

    if (!staffMap[phone]) {
      staffMap[phone] = { names: {}, jobs: [] };
      phoneOrder.push(phone);
    }
    if (name) staffMap[phone].names[name] = true;
    staffMap[phone].jobs.push({
      projectNo: projectNo,
      date:      dateOfWork,
      venue:     venue,
      finalRate: (typeof finalRate === "number") ? finalRate : parseFloat(finalRate) || 0,
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
  var titleText = monthFilter
    ? "Payroll — " + monthFilter + "  薪資表"
    : "Payroll — All Months  薪資表（所有月份）";
  dir.getRange(1, 1).setValue(titleText);
  dir.getRange(1, 1, 1, 5).mergeAcross();
  dir.getRange(1, 1)
    .setFontWeight("bold").setFontSize(13)
    .setBackground("#2563EB").setFontColor("#FFFFFF")
    .setHorizontalAlignment("center");

  // Precompute each person's total + unpaid balance (used by the FPS list and detail sections)
  for (var t = 0; t < phoneOrder.length; t++) {
    var sm = staffMap[phoneOrder[t]];
    sm.total = 0;
    sm.toPay = 0;
    for (var tj = 0; tj < sm.jobs.length; tj++) {
      sm.total += sm.jobs[tj].finalRate;
      if (!sm.jobs[tj].paid) sm.toPay += sm.jobs[tj].finalRate;
    }
  }

  var row = 2;
  var grandTotal = 0;

  // ── FPS Payment List — one row per person, pay straight down the list ──
  if (phoneOrder.length > 0) {
    dir.getRange(row, 1).setValue("💰 FPS Payment List 轉數快支付清單 — pay each row, then run 'Mark Approved as Paid' — rows marked TO PAY only 只支付標記TO PAY的行");
    dir.getRange(row, 1, 1, 5).mergeAcross();
    dir.getRange(row, 1)
      .setFontWeight("bold").setFontSize(11)
      .setBackground("#16A34A").setFontColor("#FFFFFF");
    row++;

    var fpsHeaders = ["Staff Name 姓名", "Phone (FPS) 電話", "Jobs 工作數", "Total 總額 ($)", "Status 狀態"];
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
      dir.getRange(row, 4).setValue(fStaff.total).setNumberFormat("$#,##0");
      var paidJobs = 0;
      for (var fj = 0; fj < fStaff.jobs.length; fj++) {
        if (fStaff.jobs[fj].paid) paidJobs++;
      }
      var fpsStatus = (paidJobs === fStaff.jobs.length) ? "✓ PAID 已支付"
                    : (paidJobs === 0) ? "TO PAY 待支付"
                    : "PARTIAL 部分已支付";
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
      dir.getRange(row, 5).setValue(job.paid ? "✓ Paid 已支付" : "");
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
      (monthFilter ? " for " + monthFilter : "") +
      ". 沒有已批准或已支付的提交。"
    );
  }

  // ── Auto-fit column widths to content ──
  dir.autoResizeColumns(1, 5);

  ui.alert(
    "Payroll refreshed! 薪資表已更新！\n" +
    (monthFilter ? "Month: " + monthFilter + "\n" : "All months included.\n") +
    phoneOrder.length + " staff. To pay: $" + toPayTotal +
    " · Already paid: $" + (grandTotal - toPayTotal) + "\n" +
    phoneOrder.length + " 位員工。待支付：$" + toPayTotal +
    " · 已支付：$" + (grandTotal - toPayTotal)
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
      syncMonthlyToNotion(monthFilter);
      ui.alert(
        "Notion sync finished. Check the Sync_Log tab for details.\n" +
        "Notion同步完成，詳情請查看 Sync_Log 分頁。"
      );
    }
  }
}

// ─── Mark Approved as Paid (for accounting, after FPS payout) ─
function markApprovedAsPaid() {
  var ui = SpreadsheetApp.getUi();

  var result = ui.prompt(
    "Mark as Paid 標記已支付",
    "Enter month as YYYY-MM to mark only that month,\n" +
    "or leave blank to mark ALL approved submissions:\n\n" +
    "請輸入月份 YYYY-MM（只標記該月份）\n或留空以標記所有已批准的提交：",
    ui.ButtonSet.OK_CANCEL
  );
  if (result.getSelectedButton() !== ui.Button.OK) return;

  var monthFilter = result.getResponseText().trim();
  if (monthFilter && !/^\d{4}-\d{2}$/.test(monthFilter)) {
    ui.alert(
      "Invalid format. Please use YYYY-MM (e.g. 2026-06).\n" +
      "格式錯誤，請使用 YYYY-MM（如 2026-06）。"
    );
    return;
  }

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
  var targetRows = [];
  var total = 0;
  var unsynced = 0;

  for (var i = 0; i < data.length; i++) {
    if (String(data[i][13]).trim() !== "Approved") continue;

    var dateOfWork = data[i][3];
    if (dateOfWork instanceof Date) {
      dateOfWork = Utilities.formatDate(dateOfWork, TIMEZONE, "yyyy-MM-dd");
    } else {
      dateOfWork = String(dateOfWork).trim();
    }
    if (monthFilter && dateOfWork.indexOf(monthFilter) !== 0) continue;

    targetRows.push(i + 2);
    var finalRate = data[i][12];
    total += (typeof finalRate === "number") ? finalRate : parseFloat(finalRate) || 0;
    if (!String(data[i][15]).trim()) unsynced++;
  }

  if (targetRows.length === 0) {
    ui.alert(
      "No approved submissions found" + (monthFilter ? " for " + monthFilter : "") + ".\n" +
      "沒有已批准的提交" + (monthFilter ? "（" + monthFilter + "）" : "") + "。"
    );
    return;
  }

  var confirm = ui.alert(
    "Confirm Payment 確認支付",
    targetRows.length + " approved submission(s), total $" + total +
    ", will be marked as PAID.\n" +
    (monthFilter ? "Month: " + monthFilter : "All months.") +
    (unsynced > 0
      ? "\n\n(" + unsynced + " of these not yet synced to Notion — they will still sync later.)"
      : "") +
    "\n\n" + targetRows.length + " 個已批准提交（共 $" + total + "）將標記為已支付。\n\n" +
    "Proceed? 確認繼續？",
    ui.ButtonSet.YES_NO
  );
  if (confirm !== ui.Button.YES) return;

  for (var r = 0; r < targetRows.length; r++) {
    src.getRange(targetRows[r], 14).setValue("Paid");
  }

  ui.alert(
    "✓ " + targetRows.length + " submission(s) marked as Paid ($" + total + ").\n" +
    "✓ " + targetRows.length + " 個提交已標記為已支付（共 $" + total + "）。"
  );
}

// ─── Utilities ──────────────────────────────────────────────
function _jsonResponse(obj) {
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
function notionApiCall(endpoint, method, payload) {
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
function queryNotionDB(databaseId, filterPayload) {
  return notionApiCall("databases/" + databaseId + "/query", "post", filterPayload || {});
}

// ─── Create a Notion Page ───────────────────────────────────
function createNotionPage(databaseId, properties) {
  return notionApiCall("pages", "post", {
    parent: { database_id: databaseId },
    properties: properties
  });
}

// ─── Update a Notion Page ───────────────────────────────────
function updateNotionPage(pageId, properties) {
  return notionApiCall("pages/" + pageId, "patch", { properties: properties });
}

// ─── Get a Notion Page ──────────────────────────────────────
function getNotionPage(pageId) {
  return notionApiCall("pages/" + pageId, "get");
}

// ─── Find Crew by Phone Number ──────────────────────────────
function findCrewByPhone(phone) {
  var result = queryNotionDB(CREW_DB_ID, {
    filter: {
      property: "Phone 電話",
      phone_number: { equals: phone }
    }
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
function findHiringPost(projectNo, roleType) {
  var result = queryNotionDB(HIRING_DB_ID, {
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
function createCrewEntry(name, phone) {
  var page = createNotionPage(CREW_DB_ID, {
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
function linkCrewToHiringPost(crewPageId, hiringPostPageId, existingRelationIds) {
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

  updateNotionPage(crewPageId, {
    "Jobs Assigned 派工記錄": { relation: relationArray }
  });
}

// ─── Append to Crew Work Log ────────────────────────────────
function appendWorkLog(crewPageId, existingLog, newEntry) {
  var updatedLog = existingLog ? (existingLog + "\n" + newEntry) : newEntry;
  updateNotionPage(crewPageId, {
    "Work Log 工作記錄": {
      rich_text: [{ text: { content: updatedLog } }]
    }
  });
}

// ─── Log to Sync_Log Tab ────────────────────────────────────
function logSync(syncLogSheet, row, staffName, projectNo, role, type, message) {
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
function _getSyncLogSheet() {
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
function syncMonthlyToNotion(monthFilter) {
  var syncLog = _getSyncLogSheet();

  // Check API key first
  var apiKey = PropertiesService.getScriptProperties().getProperty("NOTION_API_KEY");
  if (!apiKey) {
    logSync(syncLog, "", "", "", "", "ERROR", "NOTION_API_KEY not set. Sync aborted.");
    return;
  }

  var ss  = SpreadsheetApp.getActiveSpreadsheet();
  var src = ss.getSheetByName(SHEET_NAME);
  if (!src) {
    logSync(syncLog, "", "", "", "", "ERROR", "Timesheet_Submissions sheet not found.");
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
    if (monthFilter && dateOfWork.indexOf(monthFilter) !== 0) continue;

    var staffName = String(data[i][1]).trim();         // B: Staff Name
    var phone     = _normPhone(data[i][2]);            // C: Phone (canonical, digits only)
    var projectNo = String(data[i][9]).trim();         // J: Project No.
    var rate      = data[i][12];                       // M: Final Rate (basic + OT)
    var role      = String(data[i][14]).trim();        // O: Role

    // ── Validate ──
    if (!phone) {
      logSync(syncLog, srcRow, staffName, projectNo, role, "WARNING", "Missing phone number, skipped");
      warnings++;
      continue;
    }
    if (!projectNo) {
      logSync(syncLog, srcRow, staffName, "", role, "WARNING", "Missing Project No., skipped");
      warnings++;
      continue;
    }
    if (!role) {
      logSync(syncLog, srcRow, staffName, projectNo, "", "WARNING", "Missing Role, skipped");
      warnings++;
      continue;
    }

    try {
      // ── Find or Create Crew ──
      var crew = findCrewByPhone(phone);
      var crewPageId;
      var existingLog = "";
      var existingRelations = [];

      if (!crew.found) {
        crewPageId = createCrewEntry(staffName, phone);
        logSync(syncLog, srcRow, staffName, projectNo, role, "INFO", "New Crew created: " + staffName + " " + phone);
      } else {
        crewPageId = crew.pageId;
        existingLog = crew.workLog;
        existingRelations = crew.existingRelations;
        logSync(syncLog, srcRow, staffName, projectNo, role, "INFO", "Existing Crew found: " + staffName);
      }

      // ── Find Hiring Post ──
      var hp = findHiringPost(projectNo, role);
      if (!hp.found) {
        logSync(syncLog, srcRow, staffName, projectNo, role, "WARNING", "No Hiring Post found for " + projectNo + " + " + role);
        warnings++;
        // Still stamp as synced so we don't retry every month
        var hkt = Utilities.formatDate(new Date(), "Asia/Hong_Kong", "yyyy-MM-dd HH:mm:ss") + " (HKT)";
        src.getRange(srcRow, 16).setValue(hkt);
        continue;
      }
      if (hp.matchCount > 1) {
        logSync(syncLog, srcRow, staffName, projectNo, role, "INFO", "Multiple Hiring Posts match, using first: " + hp.jobTitle);
      }

      // ── Link Crew to Hiring Post ──
      linkCrewToHiringPost(crewPageId, hp.pageId, existingRelations);

      // ── Append Work Log ──
      var rateNum = (typeof rate === "number") ? rate : parseFloat(rate) || 0;
      var rateStr = "$" + rateNum + "/day";
      var workLogEntry = (monthFilter || dateOfWork.substring(0, 7)) + " │ " + (hp.clientMall || "—") + " │ " + projectNo + " │ " + rateStr;
      appendWorkLog(crewPageId, existingLog, workLogEntry);

      logSync(syncLog, srcRow, staffName, projectNo, role, "INFO", "Linked " + staffName + " → " + hp.jobTitle);
      synced++;

      // ── Stamp Synced ──
      var hktStamp = Utilities.formatDate(new Date(), "Asia/Hong_Kong", "yyyy-MM-dd HH:mm:ss") + " (HKT)";
      src.getRange(srcRow, 16).setValue(hktStamp);

    } catch (err) {
      logSync(syncLog, srcRow, staffName, projectNo, role, "ERROR", err.toString().substring(0, 200));
      errors++;
    }
  }

  // ── Summary ──
  logSync(syncLog, "", "", "", "", "INFO",
    "Sync complete: " + synced + " synced, " + warnings + " warnings, " + errors + " errors");
}
