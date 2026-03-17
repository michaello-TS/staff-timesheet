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

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  if (!sheet) {
    return { status: "error", message: "Sheet '" + SHEET_NAME + "' not found." };
  }

  var rowsAdded = 0;

  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i];
    var timestamp = Utilities.formatDate(new Date(), TIMEZONE, "yyyy-MM-dd HH:mm");

    // Append the row (columns A–M)
    sheet.appendRow([
      timestamp,                        // A: Submission Timestamp
      entry.staffName,                  // B: Staff Name
      entry.phoneNumber,                // C: Phone Number
      entry.dateOfWork,                 // D: Date of Work
      entry.workVenue,                  // E: Work Venue
      entry.basicRate,                  // F: Basic Rate ($)
      entry.startTime,                  // G: Start Time
      entry.endTime,                    // H: End Time
      entry.notes || "",                // I: Notes
      "",                               // J: Project No. (blank)
      "",                               // K: OT Compensation (blank)
      "",                               // L: Final Rate — formula set below
      "Pending"                         // M: Status
    ]);

    // Write the Final Rate formula into column L for the newly appended row
    var lastRow = sheet.getLastRow();
    var formulaL = '=IF(K' + lastRow + '="", F' + lastRow + ', F' + lastRow + '+K' + lastRow + ')';
    sheet.getRange("L" + lastRow).setFormula(formulaL);

    rowsAdded++;
  }

  // Email the PM a notification about this submission
  _notifyPM(entries);

  return { status: "success", rowsAdded: rowsAdded };
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

  var data = sheet.getRange(2, 1, lastRow - 1, 13).getValues();
  var submissions = [];

  for (var i = 0; i < data.length; i++) {
    var rowPhone = String(data[i][2]).trim();
    // Normalise phone (strip spaces) before comparing
    if (rowPhone.replace(/\s/g, "") === phone.replace(/\s/g, "")) {
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
        status:     String(data[i][12]).trim()
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
        " ($" + rate + ", " + e.startTime + "–" + e.endTime + ")"
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

  var lastRow = src.getLastRow();
  if (lastRow < 2) {
    dash.getRange(1, 1).setValue("No submissions yet. 尚無提交紀錄。");
    ss.setActiveSheet(dash);
    return;
  }

  var data = src.getRange(2, 1, lastRow - 1, 13).getValues();

  // Collect rows where Status = "Pending", keep source row number
  var pendingRows = [];
  for (var i = 0; i < data.length; i++) {
    if (String(data[i][12]).trim() === "Pending") {
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

  // ── Header row ──
  var headers = ["✓", "Row#", "Staff Name 姓名", "Phone 電話", "Date 日期", "Venue 地點", "Rate $ 日薪", "Hours 時間"];
  var headerRange = dash.getRange(1, 1, 1, headers.length);
  headerRange.setValues([headers]);
  headerRange.setBackground("#2563EB");
  headerRange.setFontColor("#FFFFFF");
  headerRange.setFontWeight("bold");
  headerRange.setHorizontalAlignment("center");
  headerRange.setFontSize(10);

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

    // Alternating row shade
    if (r % 2 === 1) {
      dash.getRange(rowNum, 1, 1, 8).setBackground("#F0F4FF");
    }
  }

  ss.setActiveSheet(dash);
  SpreadsheetApp.getUi().alert(
    pendingRows.length + " pending submission(s) loaded.\n" +
    pendingRows.length + " 個待審批提交已載入。\n\n" +
    "Tick the checkboxes, then use:\n" +
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

  var dashData = dash.getRange(2, 1, lastRow - 1, 2).getValues();
  var count = 0;

  for (var i = 0; i < dashData.length; i++) {
    var checked = dashData[i][0];
    var srcRow  = parseInt(dashData[i][1]);
    if (checked === true && srcRow > 1) {
      // Update column M in Timesheet_Submissions
      src.getRange(srcRow, 13).setValue(newStatus);
      // Colour the dashboard row green (approved) or red (rejected)
      dash.getRange(i + 2, 1, 1, 8).setBackground(
        newStatus === "Approved" ? "#D4EDDA" : "#FDDEDE"
      );
      // Uncheck so it can't be double-applied
      dash.getRange(i + 2, 1).setValue(false);
      count++;
    }
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

  var data = src.getRange(2, 1, lastRow - 1, 13).getValues();

  // ── Filter to Approved + optional month, group by phone ──
  var staffMap  = {};
  var phoneOrder = [];

  for (var i = 0; i < data.length; i++) {
    var status = String(data[i][12]).trim();
    if (status !== "Approved") continue;

    var dateOfWork = data[i][3];
    if (dateOfWork instanceof Date) {
      dateOfWork = Utilities.formatDate(dateOfWork, "Asia/Hong_Kong", "yyyy-MM-dd");
    } else {
      dateOfWork = String(dateOfWork).trim();
    }

    // Skip if month doesn't match the filter
    if (monthFilter && dateOfWork.indexOf(monthFilter) !== 0) continue;

    var phone     = String(data[i][2]).trim();
    var name      = String(data[i][1]).trim();
    var projectNo = String(data[i][9]).trim();
    var venue     = String(data[i][4]).trim();
    var finalRate = data[i][11];

    if (!staffMap[phone]) {
      staffMap[phone] = { names: {}, jobs: [] };
      phoneOrder.push(phone);
    }
    if (name) staffMap[phone].names[name] = true;
    staffMap[phone].jobs.push({
      projectNo: projectNo,
      date:      dateOfWork,
      venue:     venue,
      finalRate: (typeof finalRate === "number") ? finalRate : parseFloat(finalRate) || 0
    });
  }

  // ── Rebuild Staff_Directory ──
  dir.clear();

  var titleFont  = SpreadsheetApp.newTextStyle().setBold(true).setFontSize(12).build();
  var nameFont   = SpreadsheetApp.newTextStyle().setBold(false).setFontSize(10).setItalic(true).build();
  var headerFont = SpreadsheetApp.newTextStyle().setBold(true).setFontSize(10).build();
  var totalFont  = SpreadsheetApp.newTextStyle().setBold(true).setFontSize(10).build();
  var grandFont  = SpreadsheetApp.newTextStyle().setBold(true).setFontSize(12).build();

  dir.setColumnWidth(1, 18);
  dir.setColumnWidth(2, 16);
  dir.setColumnWidth(3, 22);
  dir.setColumnWidth(4, 14);

  // ── Title row showing which month was selected ──
  var titleText = monthFilter
    ? "Payroll — " + monthFilter + "  薪資表"
    : "Payroll — All Months  薪資表（所有月份）";
  dir.getRange(1, 1).setValue(titleText);
  dir.getRange(1, 1, 1, 4).mergeAcross();
  dir.getRange(1, 1)
    .setFontWeight("bold").setFontSize(13)
    .setBackground("#2563EB").setFontColor("#FFFFFF")
    .setHorizontalAlignment("center");

  var row = 2;
  var grandTotal = 0;

  for (var p = 0; p < phoneOrder.length; p++) {
    var phone     = phoneOrder[p];
    var staff     = staffMap[phone];
    var namesUsed = Object.keys(staff.names).join(" / ");

    dir.getRange(row, 1).setValue("📱 " + phone);
    dir.getRange(row, 1, 1, 4).mergeAcross();
    dir.getRange(row, 1).setTextStyle(titleFont);
    row++;

    dir.getRange(row, 1).setValue("Names: " + namesUsed);
    dir.getRange(row, 1, 1, 4).mergeAcross();
    dir.getRange(row, 1).setTextStyle(nameFont);
    row++;

    var headers = ["Project No.", "Date", "Work Venue", "Final Rate ($)"];
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

  if (phoneOrder.length > 0) {
    dir.getRange(row, 3).setValue("GRAND TOTAL 總計");
    dir.getRange(row, 3).setTextStyle(grandFont).setHorizontalAlignment("right");
    dir.getRange(row, 4).setValue(grandTotal).setNumberFormat("$#,##0").setTextStyle(grandFont);
    dir.getRange(row, 3, 1, 2).setBackground("#C6DAFC");
  } else {
    dir.getRange(2, 1).setValue(
      "No approved submissions found" +
      (monthFilter ? " for " + monthFilter : "") +
      ". 沒有已批准的提交。"
    );
  }

  ui.alert(
    "Payroll refreshed! 薪資表已更新！\n" +
    (monthFilter ? "Month: " + monthFilter + "\n" : "All months included.\n") +
    phoneOrder.length + " staff member(s), Grand Total: $" + grandTotal
  );
}

// ─── Utilities ──────────────────────────────────────────────
function _jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
