// Small helpers shared by the backend tests. All data here is made up.
"use strict";
const { formatDate } = require("./gas");

const CODE = "test-code";

function entry(o = {}) {
  return Object.assign({
    staffName: "Chan Tai Man", phoneNumber: "91234567", dateOfWork: "2026-09-10",
    workVenue: "Test Mall", basicRate: 800, startTime: "10:00", endTime: "18:00",
    pic: "Michael", notes: "",
  }, o);
}

function submit(be, entries, extra = {}) {
  return be.post(Object.assign({ action: "submit", accessCode: CODE, entries }, extra));
}

function status(be, phone, code = CODE) {
  return be.post({ action: "status", accessCode: code, phoneNumber: phone });
}

// Write a row straight into Timesheet_Submissions, as if submitted earlier and
// then handled by a PM. m: undefined = normal formula, "blank" = no formula.
function addRow(be, o = {}) {
  const e = entry(o);
  if (o.venue) e.workVenue = o.venue;
  const tab = be.tab();
  const r = tab.getLastRow() + 1;
  const vals = [o.ts || "2026-09-30 12:00", e.staffName, e.phoneNumber, e.dateOfWork, e.workVenue, e.basicRate,
    e.startTime, e.endTime, e.notes, o.projectNo || "", e.pic, o.ot === undefined ? "" : o.ot, "",
    o.status || "Pending", o.role || "", o.synced || ""];
  vals.forEach((v, i) => tab.write(r, i + 1, v));
  if (o.m !== "blank") tab.getRange("M" + r).setFormula(`=IF(L${r}="", F${r}, F${r}+L${r})`);
  return r;
}

function rowObj(be, r) {
  const v = be.tab().getRange(r, 1, 1, 16).getValues()[0];
  return {
    r, name: v[1], phone: v[2], date: v[3] instanceof Date ? formatDate(v[3], "Asia/Hong_Kong", "yyyy-MM-dd") : v[3],
    venue: v[4], rate: v[5], notes: v[8], projectNo: v[9], pic: v[10], ot: v[11], m: v[12], status: v[13], role: v[14], synced: v[15],
  };
}
function rows(be) {
  const out = [];
  for (let r = 2; r <= be.tab().getLastRow(); r++) out.push(rowObj(be, r));
  return out;
}

// Show Pending → tick rows matching pred(dashboardRow) → fill Project No./Role → Approve (or Reject)
function approveViaDashboard(be, pred, fill = {}, action = "approveSelected") {
  be.call("showPendingDashboard");
  const dash = be.sheet("Dashboard");
  let ticked = 0;
  for (let r = 2; r <= dash.getLastRow(); r++) {
    const v = dash.getRange(r, 1, 1, 12).getValues()[0];
    const d = { r, name: v[2], phone: String(v[3]), date: v[4] instanceof Date ? formatDate(v[4], "Asia/Hong_Kong", "yyyy-MM-dd") : v[4], venue: v[5], rate: v[6], notes: v[11] };
    if (!pred(d)) continue;
    dash.write(r, 1, true);
    dash.getRange(r, 9).setValue(fill.projectNo === undefined ? "P100" : fill.projectNo);
    dash.write(r, 11, fill.role || "Event Helper");
    ticked++;
  }
  be.ui.responses.push("YES");
  be.call(action);
  be.ui.responses.length = 0;
  return ticked;
}

function runPayroll(be, months, syncAnswer = "NO") {
  be.ui.responses.push(syncAnswer);
  be.call("runPayrollForMonths", months);
  be.ui.responses.length = 0;
}

// Deployed backend: month picker. New backend: pick a payment list (batch),
// the newest unless `batch` (an index into the newest-first list) is given.
function markPaid(be, months, answer = "YES", batch = 0) {
  be.ui.responses.push(answer);
  if (be.ctx.runMarkPaidBatch) {
    const list = be.ctx._loadPayBatches_();
    if (list[batch]) be.call("runMarkPaidBatch", list[batch].id);
    else be.call("markApprovedAsPaid");
  } else {
    be.call("runMarkPaidForMonths", months);
  }
  be.ui.responses.length = 0;
}
function batches(be) { return be.ctx._loadPayBatches_ ? be.ctx._loadPayBatches_() : []; }

// The FPS list at the top of Staff_Directory, one object per person.
function fpsList(be) {
  const v = be.sheet("Staff_Directory").values();
  const h = v.findIndex((row) => String(row[0]).startsWith("Staff Name"));
  const out = [];
  for (let i = h + 1; i < v.length && v[i][0] !== ""; i++) {
    out.push({ name: v[i][0], phone: String(v[i][1]), jobs: v[i][2], amount: v[i][3], status: String(v[i][4]), header: v[h][3] });
  }
  return out;
}

function lastAlert(be) { return be.ui.alerts[be.ui.alerts.length - 1] || ""; }

module.exports = { CODE, batches, entry, submit, status, addRow, rowObj, rows, approveViaDashboard, runPayroll, markPaid, fpsList, lastAlert };
