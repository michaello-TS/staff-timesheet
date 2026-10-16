// Round 2: one test per defect found by the independent review of PR #2,
// using the reviewer's exact scenarios (new backend; the deployed one only
// where it shows the problem).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadBackend } = require("../harness/gas");
const H = require("../harness/helpers");

const be = (opts) => loadBackend("new", opts);
const statusOf = (b, venue) => H.rows(b).find((r) => r.venue === venue).status;

// ─── #1 MAJOR: second Refresh before Mark as Paid ────────────
function twoRefreshes(b) {
  H.addRow(b, { status: "Approved", basicRate: 800, venue: "Job A", ts: "2026-09-20 10:00" });
  H.runPayroll(b, ["2026-09"]);                                    // list 1: A $800 — accounting pays this
  H.addRow(b, { status: "Approved", basicRate: 1000, venue: "Job B", dateOfWork: "2026-09-25", ts: "2026-09-26 10:00" });
  H.runPayroll(b, ["2026-09"]);                                    // list 2: A + B
}

test("R01 #1: Refresh (A) → pay A → approve B → Refresh again → Mark as Paid on list 1 marks ONLY A", () => {
  const b = be();
  twoRefreshes(b);
  const lists = H.batches(b);
  assert.equal(lists.length, 2);
  assert.deepEqual(lists.map((l) => [l.count, l.total]), [[2, 1800], [1, 800]]);   // newest first
  H.markPaid(b, ["2026-09"], "YES", 1);                            // the list accounting paid from
  assert.equal(statusOf(b, "Job A"), "Paid");
  assert.equal(statusOf(b, "Job B"), "Approved");                  // never paid → stays Approved
  assert.ok(b.ui.alerts.some((a) => /Payment list .*1 job\(s\), HK\$800\./.test(a)));   // confirm shows that list's total
});

test("R02 #1: the picker lists unpaid lists newest first with HK$ totals and job counts", () => {
  const b = be();
  twoRefreshes(b);
  b.call("markApprovedAsPaid");
  const html = b.ui.dialogs[b.ui.dialogs.length - 1].html;
  const shown = [...html.matchAll(/(\d+) job\(s\) 個工作 · <b>(HK\$[\d,]+)<\/b>/g)].map((m) => m[1] + " " + m[2]);
  assert.deepEqual(shown, ["2 HK$1,800", "1 HK$800"]);
  assert.match(html, /\["runMarkPaidBatch"\]\(sel\)/);
  assert.match(html, /newest 最新/);
  assert.doesNotMatch(html, /\schecked[\s>]/);                     // nothing pre-selected: the user must choose
  const script = html.match(/<script>([\s\S]*)<\\?\/script>/)[1];
  assert.doesNotThrow(() => new Function(script));                  // the window's own script is valid JS
});

test("R03 #1: after list 1 is paid, list 2 shrinks to the job still owed (B, HK$1,000), and paying it marks B", () => {
  const b = be();
  twoRefreshes(b);
  H.markPaid(b, ["2026-09"], "YES", 1);
  const lists = H.batches(b);
  assert.equal(lists.length, 1);
  assert.deepEqual([lists[0].count, lists[0].total], [1, 1000]);
  H.markPaid(b, ["2026-09"]);
  assert.equal(statusOf(b, "Job B"), "Paid");
  assert.equal(H.batches(b).length, 0);                            // paid lists are removed
});

test("R04 #1: paying the NEWEST list (A + B) marks both and leaves no list behind", () => {
  const b = be();
  twoRefreshes(b);
  H.markPaid(b, ["2026-09"], "YES", 0);
  assert.equal(statusOf(b, "Job A"), "Paid");
  assert.equal(statusOf(b, "Job B"), "Paid");
  assert.equal(H.batches(b).length, 0);
});

test("R05 #1: a Notion time-out points to Sync to Notion, which finishes the sync without a new payment list", () => {
  const b = be();
  b.notion.addHiring({ title: "T", projectNo: "P100", role: "Event Helper" });
  const r = H.addRow(b, { status: "Approved", projectNo: "P100", role: "Event Helper" });
  b.ctx.RUN_START_MS_ = Date.now() - 6 * 60 * 1000;
  H.runPayroll(b, ["2026-09"], "YES");
  assert.match(H.lastAlert(b), /Sync to Notion/);
  assert.doesNotMatch(H.lastAlert(b), /Refresh Payroll again/);
  const before = H.batches(b).length;
  b.ctx.RUN_START_MS_ = Date.now();
  b.call("syncToNotion");
  assert.match(b.ui.dialogs[b.ui.dialogs.length - 1].html, /\["runSyncForMonths"\]/);
  b.call("runSyncForMonths", ["2026-09"]);
  assert.match(String(H.rowObj(b, r).synced), /\(HKT\)$/);
  assert.equal(H.batches(b).length, before);
  assert.match(H.lastAlert(b), /Notion sync finished: 1 synced/);
});

test("R06 #1: payment lists expire after 45 days", () => {
  const b = be();
  H.addRow(b, { status: "Approved" });
  H.runPayroll(b, ["2026-09"]);
  const store = JSON.parse(b.docProps.getProperty("PAY_BATCHES_0"));
  store.batches[0].atMs -= 46 * 86400000;
  b.ctx._writeChunked_("PAY_BATCHES_", store);
  assert.equal(H.batches(b).length, 0);
  b.call("markApprovedAsPaid");
  assert.match(H.lastAlert(b), /No unpaid payment list/);
  assert.equal(H.rows(b)[0].status, "Approved");
});

test("R07 #1: a list whose jobs were all marked Paid by hand changes nothing and is dropped", () => {
  const b = be();
  const r = H.addRow(b, { status: "Approved" });
  H.runPayroll(b, ["2026-09"]);
  const id = H.batches(b)[0].id;
  b.tab().getRange(r, 14).setValue("Paid");
  b.call("runMarkPaidBatch", id);
  assert.match(H.lastAlert(b), /Nothing was changed/);
  assert.equal(H.batches(b).length, 0);
});

test("R08 #1: a forged / unknown batch id is refused", () => {
  const b = be();
  H.addRow(b, { status: "Approved" });
  H.runPayroll(b, ["2026-09"]);
  b.call("runMarkPaidBatch", "<script>");
  assert.match(H.lastAlert(b), /no longer exists/);
  assert.equal(H.rows(b)[0].status, "Approved");
});

test("R09 #1: a refresh with nothing to pay saves no list", () => {
  const b = be();
  H.addRow(b, { status: "Paid" });
  H.runPayroll(b, ["2026-09"]);
  assert.equal(H.batches(b).length, 0);
});

// ─── #4: stale keys ──────────────────────────────────────────
test("R10 #4: job on a list marked Paid by hand; a later IDENTICAL job is NOT marked Paid from the old list", () => {
  const b = be();
  const r = H.addRow(b, { status: "Approved", venue: "Same Mall", ts: "2026-09-12 09:00" });
  H.runPayroll(b, ["2026-09"]);
  b.tab().getRange(r, 14).setValue("Paid");                        // PM sets Paid by hand
  H.addRow(b, { status: "Approved", venue: "Same Mall", ts: "2026-09-28 18:30" });  // same person/date/venue/amount, new submission
  H.markPaid(b, ["2026-09"]);
  const rows = H.rows(b);
  assert.equal(rows[0].status, "Paid");
  assert.equal(rows[1].status, "Approved");
});

test("R11 #4: an edited job (amount changed after the list) is not marked Paid from the old list, and the next refresh drops the stale entry", () => {
  const b = be();
  const r = H.addRow(b, { status: "Approved", basicRate: 800 });
  H.runPayroll(b, ["2026-09"]);
  b.tab().getRange(r, 12).setValue(200);                           // PM adds OT after the list was made
  H.markPaid(b, ["2026-09"]);
  assert.equal(H.rows(b)[0].status, "Approved");
  H.runPayroll(b, ["2026-09"]);
  assert.deepEqual(H.batches(b).map((l) => l.total), [1000]);      // only the fresh list remains
});

// ─── #2: same-day shifts and the approve guard ───────────────
test("R12 #2: two same-day shifts (same venue/rate) can't swap Project No./Role after a sort", () => {
  const b = be();
  H.addRow(b, { startTime: "10:00", endTime: "13:00", notes: "morning" });
  H.addRow(b, { startTime: "14:00", endTime: "18:00", notes: "afternoon" });
  b.call("showPendingDashboard");
  b.tab().sortDataRows(7, true);                                   // sort by start time, newest first → rows swap
  const dash = b.sheet("Dashboard");
  dash.write(2, 1, true);                                          // tick the MORNING shift
  dash.getRange(2, 9).setValue("P-MORNING");
  dash.write(2, 11, "Promoter");
  b.call("approveSelected");
  const rows = H.rows(b);
  assert.deepEqual(rows.map((r) => [r.notes, r.status, r.projectNo]), [["afternoon", "Pending", ""], ["morning", "Pending", ""]]);
  assert.ok(b.ui.alerts.some((a) => /SKIPPED/.test(a)));
});

test("R13 #2: without a sort, both shifts approve normally with their own Project No.", () => {
  const b = be();
  H.addRow(b, { startTime: "10:00", endTime: "13:00", notes: "morning" });
  H.addRow(b, { startTime: "14:00", endTime: "18:00", notes: "afternoon" });
  H.approveViaDashboard(b, (d) => d.notes === "morning", { projectNo: "P-AM" });
  H.approveViaDashboard(b, (d) => d.notes === "afternoon", { projectNo: "P-PM" });
  assert.deepEqual(H.rows(b).map((r) => [r.status, r.projectNo]), [["Approved", "P-AM"], ["Approved", "P-PM"]]);
});

// ─── #3: formula failure after the row is written ────────────
test("R14 #3: if setting the Final Rate formula fails, the row is still reported saved and a retry adds no duplicate", () => {
  const b = be({ failFormulaAt: 1 });
  const entries = [Object.assign(H.entry(), { entryId: "formulafail-1" }), Object.assign(H.entry({ dateOfWork: "2026-09-11" }), { entryId: "formulafail-2" })];
  const res = H.submit(b, entries);
  assert.equal(res.status, "error");
  assert.deepEqual(res.savedEntries, [1]);
  const retry = H.submit(b, entries);
  assert.deepEqual(retry.alreadySaved, [1]);
  assert.equal(retry.rowsAdded, 1);
  assert.deepEqual(H.rows(b).map((r) => r.date), ["2026-09-10", "2026-09-11"]);
  // the row without a formula is still paid correctly (F + L fallback)
  b.tab().getRange(2, 14).setValue("Approved");
  H.runPayroll(b, ["2026-09"]);
  assert.equal(H.fpsList(b)[0].amount, 800);
});

// ─── #5: sheet time zone other than Hong Kong ────────────────
for (const tz of ["Pacific/Auckland", "America/New_York"]) {
  test(`R15 #5: with the Sheet set to ${tz}, dates stay correct in status, duplicate check, approve guard, payroll and month filter`, () => {
    const b = be({ sheetTz: tz });
    const res1 = H.submit(b, [H.entry({ dateOfWork: "2026-09-01" })]);
    assert.equal(res1.status, "success");
    assert.equal(H.status(b, "91234567").submissions[0].dateOfWork, "2026-09-01");
    assert.equal(H.status(b, "91234567").submissions[0].startTime, "10:00");
    assert.deepEqual(H.submit(b, [H.entry({ dateOfWork: "2026-09-01", startTime: "19:00", endTime: "22:00" })]).duplicates, [1]);
    H.submit(b, [H.entry({ dateOfWork: "2026-08-31", workVenue: "Aug Mall" })]);
    assert.equal(H.approveViaDashboard(b, () => true), 3);
    assert.deepEqual(H.rows(b).map((r) => r.status), ["Approved", "Approved", "Approved"]);
    H.runPayroll(b, ["2026-09"]);
    assert.equal(H.fpsList(b)[0].jobs, 2);                         // 31 Aug stays out of September
    H.markPaid(b, ["2026-09"]);
    assert.equal(H.rows(b).find((r) => r.venue === "Aug Mall").status, "Approved");
  });
}

test("R16 #5: the deployed backend shows the problem — in an Auckland-zoned sheet 1 Sep reads back as 31 Aug", () => {
  const b = loadBackend("deployed", { sheetTz: "Pacific/Auckland" });
  H.submit(b, [H.entry({ dateOfWork: "2026-09-01" })]);
  assert.equal(H.status(b, "91234567").submissions[0].dateOfWork, "2026-08-31");
});
