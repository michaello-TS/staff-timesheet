// Round 3: re-review of the payment-list batches (new backend).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadBackend } = require("../harness/gas");
const H = require("../harness/helpers");

const be = (opts) => loadBackend("new", opts);
const pickerRows = (b) => {
  b.call("markApprovedAsPaid");
  const html = b.ui.dialogs[b.ui.dialogs.length - 1].html;
  return [...html.matchAll(/<b>#(\d+)<\/b> · <b>([^<]+)<\/b>.*?(\d+) job\(s\) 個工作 · <b>(HK\$[\d,]+)<\/b>/g)]
    .map((m) => ({ no: +m[1], at: m[2], jobs: +m[3], total: m[4] }));
};

test("T01 #1: Refresh (A $800), then 10 refreshes with new approvals → the $800 list is still selectable and marks only A", () => {
  const b = be();
  H.addRow(b, { status: "Approved", basicRate: 800, venue: "Job A", ts: "2026-09-01 09:00" });
  H.runPayroll(b, ["2026-09"]);
  for (let i = 1; i <= 10; i++) {
    H.addRow(b, { status: "Approved", basicRate: 500, venue: "Late " + i, dateOfWork: "2026-09-" + String(10 + i), ts: "2026-09-" + String(10 + i) + " 09:00" });
    H.runPayroll(b, ["2026-09"]);
  }
  const rows = pickerRows(b);
  assert.equal(rows.length, 11);                                   // no count cap
  const oldest = rows[rows.length - 1];
  assert.deepEqual([oldest.no, oldest.jobs, oldest.total], [11, 1, "HK$800"]);
  H.markPaid(b, ["2026-09"], "YES", 10);                           // the $800 list
  const st = Object.fromEntries(H.rows(b).map((r) => [r.venue, r.status]));
  assert.equal(st["Job A"], "Paid");
  for (let i = 1; i <= 10; i++) assert.equal(st["Late " + i], "Approved");
  assert.ok(b.ui.alerts.some((a) => /Payment list #11 · .*1 job\(s\), HK\$800\./.test(a)));
});

test("T02 #1: a refresh identical to the newest unpaid list does not add another list", () => {
  const b = be();
  H.addRow(b, { status: "Approved", venue: "Job A" });
  H.runPayroll(b, ["2026-09"]);
  H.runPayroll(b, ["2026-09"]);
  H.runPayroll(b, ["2026-09"]);
  assert.equal(H.batches(b).length, 1);
  H.addRow(b, { status: "Approved", venue: "Job B", dateOfWork: "2026-09-12", ts: "2026-09-12 10:00" });
  H.runPayroll(b, ["2026-09"]);
  H.runPayroll(b, ["2026-09"]);
  assert.deepEqual(H.batches(b).map((l) => l.count), [2, 1]);
});

test("T03 #1: a different month selection is a different list (not merged into the newest)", () => {
  const b = be();
  H.addRow(b, { status: "Approved", venue: "Aug", dateOfWork: "2026-08-20" });
  H.addRow(b, { status: "Approved", venue: "Sep", dateOfWork: "2026-09-20", ts: "2026-09-21 10:00" });
  H.runPayroll(b, ["2026-09"]);
  H.runPayroll(b, ["2026-08"]);
  H.runPayroll(b, ["2026-09"]);                                    // same jobs as an OLDER list, not the newest → kept
  assert.deepEqual(H.batches(b).map((l) => l.count), [1, 1, 1]);
});

test("T04 #1: lists leave only when fully paid or after 45 days", () => {
  const b = be();
  H.addRow(b, { status: "Approved", venue: "Job A" });
  H.runPayroll(b, ["2026-09"]);
  H.addRow(b, { status: "Approved", venue: "Job B", dateOfWork: "2026-09-12", ts: "2026-09-12 10:00" });
  H.runPayroll(b, ["2026-09"]);
  assert.equal(H.batches(b).length, 2);
  H.markPaid(b, ["2026-09"], "YES", 0);                            // A + B paid → both lists are fully paid
  assert.equal(H.batches(b).length, 0);
});

test("T05 #1: 30 overlapping lists of up to 300 jobs fit easily in Document Properties", () => {
  const b = be();
  const key = (i) => `9${String(1000000 + i).slice(1)}0|2026-09-${String(1 + (i % 28)).padStart(2, "0")}|800|商場 Venue ${i}|2026-09-30 12:00:${String(i % 60).padStart(2, "0")}`;
  const lists = [];
  for (let n = 0; n < 30; n++) {
    const counts = {};
    for (let i = 0; i < 10 * (n + 1); i++) counts[key(i)] = 1;
    lists.push({ id: "x-" + n, seq: n + 1, atMs: Date.now() - n * 1000, at: "t", months: "2026-09", total: 0, count: Object.keys(counts).length, counts });
  }
  b.ctx._writePayBatches_(lists);
  const bytes = Object.entries(b.docProps.getProperties()).reduce((s, [k, v]) => s + Buffer.byteLength(k + v), 0);
  assert.ok(bytes < 100 * 1024, "stored " + bytes + " bytes");      // quota is 500 KB
  assert.equal(H.batches(b).length, 30);
  assert.equal(H.batches(b)[29].count, 300);
});

test("T06 #2: lists are numbered #1 (newest) … and show seconds, so two lists in the same minute look different", () => {
  const b = be();
  H.addRow(b, { status: "Approved", venue: "Job A" });
  H.runPayroll(b, ["2026-09"]);
  H.addRow(b, { status: "Approved", venue: "Job B", dateOfWork: "2026-09-12", ts: "2026-09-12 10:00" });
  H.runPayroll(b, ["2026-09"]);
  const rows = pickerRows(b);
  assert.deepEqual(rows.map((r) => r.no), [1, 2]);
  for (const r of rows) assert.match(r.at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.deepEqual(rows.map((r) => [r.jobs, r.total]), [[2, "HK$1,600"], [1, "HK$800"]]);
  const ids = H.batches(b).map((l) => l.id);
  assert.equal(new Set(ids).size, 2);                              // distinct even within the same millisecond
  H.markPaid(b, ["2026-09"], "YES", 1);
  assert.ok(b.ui.alerts.some((a) => /Payment list #2 · \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} /.test(a)));
});
