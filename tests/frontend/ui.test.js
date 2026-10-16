// index.html in headless Chromium (Playwright). Every request to
// script.google.com is intercepted and answered by the REAL Code.gs running in
// the Node harness (tests/harness/gas.js), so these are end-to-end runs of
// page + backend with nothing leaving the machine.
//
// Page variants:    new = index.html (repo root)   deployed = tests/fixtures/index.deployed.html
// Backend variants: new = deliverables/Code.gs     deployed = tests/fixtures/Code.deployed.gs
//
// U01–U08 are the 8 front-end checks from the October health check: the
// deployed page reproduces each bug, the new page is checked against BOTH
// backends (staff use the new page before the owner pastes the new Code.gs).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { loadBackend, ROOT } = require("../harness/gas");
const H = require("../harness/helpers");

const PAGES = {
  new: path.join(ROOT, "index.html"),
  deployed: path.join(__dirname, "..", "fixtures", "index.deployed.html"),
};
const JOB = { date: "2026-09-10", venue: "Test Mall", rate: "800", start: "10:00", end: "18:00", pic: "Michael", notes: "" };

let browser;
test.before(async () => { browser = await chromium.launch(); });
test.after(async () => { if (browser) await browser.close(); });

async function open(pageVariant, backendVariant, beOpts) {
  const be = loadBackend(backendVariant, beOpts);
  const server = { plan: { submit: [], status: [] }, log: [], inflight: 0 };
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  // Run the page's timers 20× faster so the "checking if saved" waits don't slow the suite.
  await page.addInitScript(() => {
    const st = window.setTimeout.bind(window);
    window.setTimeout = (fn, ms, ...a) => st(fn, Math.ceil((ms || 0) / 20), ...a);
  });
  await page.route("http://timesheet.test/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: fs.readFileSync(PAGES[pageVariant]) }));
  await page.route("https://script.google.com/**", async (route) => {
    server.inflight++;
    try {
      const body = route.request().postData() || "";
      const p = JSON.parse(body);
      server.log.push(p);
      const step = (server.plan[p.action] || []).shift() || "ok";
      if (step === "abortBefore") return await route.abort("failed");     // never reached the script
      if (step === "failMidway") be.ss.opts.failAppendAt = be.ss.appendCalls + 2;
      const text = be.postRaw(body);
      be.ss.opts.failAppendAt = 0;
      if (step === "abortAfter") return await route.abort("failed");      // script ran, reply lost
      await route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: text });
    } finally {
      server.inflight--;
    }
  });
  await page.goto("http://timesheet.test/index.html");
  server.idle = async () => { for (let i = 0; i < 200 && server.inflight > 0; i++) await page.waitForTimeout(10); await page.waitForTimeout(30); };
  return { page, be, server, close: () => context.close() };
}

async function login(page, code = "test-code") {
  await page.fill("#accessCodeInput", code);
  await page.click("#authBtn");
  await page.waitForSelector("#mainSection:not(.hidden)");
}

async function fill(page, jobs = [JOB], who = { name: "Chan Tai Man", phone: "9123 4567" }) {
  await page.fill("#staffName", who.name);
  await page.fill("#phoneNumber", who.phone);
  for (let i = 0; i < jobs.length; i++) {
    const n = await page.locator(".job-entry").count();
    if (i >= n) await page.click("#addJobBtn");
    const id = await page.locator(".job-entry").nth(i).getAttribute("data-entry-id");
    const j = Object.assign({}, JOB, jobs[i]);
    await page.fill("#date_" + id, j.date);
    await page.fill("#venue_" + id, j.venue);
    await page.fill("#rate_" + id, j.rate);
    await page.fill("#start_" + id, j.start);
    await page.fill("#end_" + id, j.end);
    await page.selectOption("#pic_" + id, j.pic);
    await page.fill("#notes_" + id, j.notes);
  }
}

// Submit → confirm screen → Confirm. Returns "success" | "alert" | "auth" | "form".
async function submitAndWait(t) {
  const { page, server } = t;
  await page.click("#submitBtn");
  const state = await page.waitForFunction(() =>
    !document.querySelector("#confirmSection").classList.contains("hidden") ||
    !document.querySelector("#authSection").classList.contains("hidden") ||
    document.querySelector(".field-error-msg"), null, { timeout: 5000 });
  if (await page.locator(".field-error-msg").count()) return "form";
  await server.idle();                                    // let the confirm screen's lookup answer
  if (await page.isVisible("#authSection")) return "auth";
  await page.click("#confirmSubmitBtn");
  await page.waitForFunction(() =>
    document.querySelector("#successSection").classList.contains("active") ||
    !document.querySelector("#authSection").classList.contains("hidden") ||
    (document.querySelector("#globalAlert").classList.contains("active") &&
      document.querySelector("#confirmSection").classList.contains("hidden")), null, { timeout: 15000 });
  await server.idle();
  if (await page.locator("#successSection.active").count()) return "success";
  if (await page.isVisible("#authSection")) return "auth";
  return "alert";
}
const alertText = (page) => page.textContent("#globalAlert");
const successText = (page) => page.textContent("#successSection");

// ─── U01–U08: the original 8 front-end checks ───────────────
const COMBOS = [["deployed", "deployed"], ["new", "deployed"], ["new", "new"]];
for (const [pv, bv] of COMBOS) {
  const fixed = pv === "new";
  const label = `[page:${pv} backend:${bv}]`;
  const run = (id, title, fn) => test(`${id} ${label} ${title}`, async () => {
    const t = await open(pv, bv);
    try { await fn(t); } finally { await t.close(); }
  });

  run("U01", "D1: lost reply + earlier record of a DIFFERENT shift " + (fixed ? "is not taken as saved (fixed)" : "shows a false 'Saved' (bug reproduced)"), async (t) => {
    H.addRow(t.be, { startTime: "10:00", endTime: "13:00" });
    await login(t.page);
    await fill(t.page);
    t.server.plan.submit = ["abortBefore"];
    const out = await submitAndWait(t);
    assert.equal(t.be.tab().getLastRow(), 2);           // the 10:00–18:00 job never reached the sheet
    if (fixed) {
      assert.equal(out, "alert");
      assert.match(await alertText(t.page), /Could not confirm/);
    } else {
      assert.equal(out, "success");
      assert.match(await successText(t.page), /Saved/);
    }
  });

  run("U02", "D1: lost reply + an earlier REJECTED record " + (fixed ? "is not taken as saved (fixed)" : "shows a false 'Saved' (bug reproduced)"), async (t) => {
    H.addRow(t.be, { status: "Rejected" });
    await login(t.page);
    await fill(t.page);
    t.server.plan.submit = ["abortBefore"];
    const out = await submitAndWait(t);
    assert.equal(out, fixed ? "alert" : "success");
    assert.equal(t.be.tab().getLastRow(), 2);
  });

  run("U03", "lost reply with nothing on record → honest 'could not confirm'", async (t) => {
    await login(t.page);
    await fill(t.page);
    t.server.plan.submit = ["abortBefore"];
    assert.equal(await submitAndWait(t), "alert");
    assert.match(await alertText(t.page), /Could not confirm.*未能確認/s);
  });

  run("U04", "D2: server error after job 1 of 3 " + (fixed ? "says which job is saved; retry adds no duplicate (fixed)" : "says 'failed, retry' without checking (bug reproduced)"), async (t) => {
    await login(t.page);
    await fill(t.page, [{ date: "2026-09-01" }, { date: "2026-09-02" }, { date: "2026-09-03" }]);
    t.server.plan.submit = ["failMidway"];
    const n0 = t.server.log.length;
    assert.equal(await submitAndWait(t), "alert");
    assert.equal(t.be.tab().getLastRow(), 2);           // job 1 is in the sheet
    const acts = t.server.log.slice(n0).map((p) => p.action);
    const after = acts.slice(acts.indexOf("submit") + 1);         // requests after the submit itself
    if (!fixed) {
      assert.match(await alertText(t.page), /請重試/);
      assert.deepEqual(after.filter((a) => a === "status"), []);   // never checked what was saved
      return;
    }
    assert.match(await alertText(t.page), /Saved 已儲存: 2026-09-01 Test Mall/);
    assert.equal(await t.page.locator(".job-entry").count(), 2);  // only the unsaved jobs remain
    assert.equal(await submitAndWait(t), "success");
    const dates = H.rows(t.be).map((r) => r.date);
    assert.deepEqual(dates, ["2026-09-01", "2026-09-02", "2026-09-03"]);
  });

  run("U05", "F1: after the access code changes " + (fixed ? "the page asks for the new code and keeps the form (fixed)" : "every submit fails with no way back (bug reproduced)"), async (t) => {
    await login(t.page);
    await fill(t.page, [{ venue: "Kept Venue" }]);
    t.be.scriptProps.setProperty("ACCESS_CODE", "new-code");
    const out = await submitAndWait(t);
    if (!fixed) {
      assert.equal(out, "alert");
      assert.match(await alertText(t.page), /Invalid access code/);
      await t.page.reload();
      assert.ok(await t.page.isVisible("#mainSection"));          // still skips the code screen
      assert.ok(!(await t.page.isVisible("#authSection")));
      return;
    }
    assert.equal(out, "auth");
    assert.match(await alertText(t.page), /access code has changed.*存取碼已更改/s);
    await login(t.page, "new-code");
    const id = await t.page.locator(".job-entry").first().getAttribute("data-entry-id");
    assert.equal(await t.page.inputValue("#venue_" + id), "Kept Venue");
    assert.equal(await submitAndWait(t), "success");
    assert.equal(t.be.tab().getLastRow(), 2);
  });

  run("U06", "status view shows hostile text as text (no script runs)", async (t) => {
    H.addRow(t.be, { venue: "<img src=x onerror=\"window.__xss=1\">" });
    await login(t.page);
    await t.page.click("#checkStatusBtn");
    await t.page.fill("#statusPhone", "91234567");
    await t.page.click("#statusCheckBtn");
    await t.page.waitForSelector(".status-item");
    assert.match(await t.page.textContent("#statusResults"), /<img src=x/);
    assert.equal(await t.page.locator("#statusResults img").count(), 0);
    assert.equal(await t.page.evaluate(() => window.__xss), undefined);
  });

  run("U07", "F2: buttons are at least 48 px tall " + (fixed ? "(fixed)" : "(bug reproduced: some are smaller)"), async (t) => {
    await login(t.page);
    await t.page.click("#addJobBtn");
    const heights = await t.page.$$eval("#mainSection button", (bs) =>
      bs.filter((b) => b.offsetParent).map((b) => ({ t: b.textContent.trim().slice(0, 20), h: b.getBoundingClientRect().height })));
    const small = heights.filter((x) => x.h < 48);
    if (fixed) assert.deepEqual(small, []);
    else assert.ok(small.length >= 2, JSON.stringify(heights));
  });

  run("U08", "+852 phone is rejected with a bilingual message before anything is sent", async (t) => {
    await login(t.page);
    await fill(t.page, [JOB], { name: "Chan Tai Man", phone: "+852 9123 4567" });
    assert.equal(await submitAndWait(t), "form");
    const msg = await t.page.textContent(".field-error-msg");
    assert.match(msg, /8-digit HK mobile/);
    assert.match(msg, /香港手提號碼/);
    assert.ok(!t.server.log.some((p) => p.action === "submit"));
  });
}

// ─── New page × both backends: the safe-submit paths ─────────
for (const bv of ["deployed", "new"]) {
  const run = (id, title, fn) => test(`${id} [page:new backend:${bv}] ${title}`, async () => {
    const t = await open("new", bv);
    try { await fn(t); } finally { await t.close(); }
  });

  run("U09", "normal submit: one row, status shows it Pending", async (t) => {
    await login(t.page);
    await fill(t.page);
    assert.equal(await submitAndWait(t), "success");
    assert.equal(t.be.tab().getLastRow(), 2);
    await t.page.click("#successStatusBtn");
    await t.page.click("#statusCheckBtn");
    await t.page.waitForSelector(".status-item");
    assert.match(await t.page.textContent("#statusResults"), /Pending 待審批/);
  });

  run("U10", "reply lost AFTER the row was written → verified 'Saved', exactly one row", async (t) => {
    await login(t.page);
    await fill(t.page);
    t.server.plan.submit = ["abortAfter"];
    assert.equal(await submitAndWait(t), "success");
    assert.match(await successText(t.page), /Saved 已儲存/);
    assert.equal(t.be.tab().getLastRow(), 2);
  });

  run("U11", "reply lost + same job already on record for the same shift → only a NEW record counts", async (t) => {
    H.addRow(t.be, {});                                  // identical job submitted last week
    await login(t.page);
    await fill(t.page);
    t.server.plan.submit = ["abortAfter"];
    assert.equal(await submitAndWait(t), "success");    // count went 1 → 2
    assert.equal(t.be.tab().getLastRow(), 3);
  });

  run("U12", "every job is sent with an entryId; old and new backends both accept it", async (t) => {
    await login(t.page);
    await fill(t.page, [{ date: "2026-09-01" }, { date: "2026-09-02" }]);
    assert.equal(await submitAndWait(t), "success");
    const sub = t.server.log.find((p) => p.action === "submit");
    assert.equal(sub.entries.length, 2);
    for (const e of sub.entries) assert.match(e.entryId, /^e[0-9a-f]{24}$/);
    assert.notEqual(sub.entries[0].entryId, sub.entries[1].entryId);
    assert.deepEqual(Object.keys(sub).sort(), ["accessCode", "action", "entries"]);
    assert.equal(t.be.tab().getLastRow(), 3);
  });

  run("U13", "status checker with a stale access code returns to the code screen", async (t) => {
    await login(t.page);
    t.be.scriptProps.setProperty("ACCESS_CODE", "new-code");
    await t.page.click("#checkStatusBtn");
    await t.page.fill("#statusPhone", "91234567");
    await t.page.click("#statusCheckBtn");
    await t.page.waitForSelector("#authSection:not(.hidden)");
    assert.match(await alertText(t.page), /access code has changed/);
  });

  run("U14", "a real server error with nothing saved says 'not saved, submit again'", async (t) => {
    await login(t.page);
    await fill(t.page);
    t.be.ss.opts.lockTimeout = true;
    assert.equal(await submitAndWait(t), "alert");
    assert.match(await alertText(t.page), /Nothing was saved.*未有儲存任何紀錄/s);
    t.be.ss.opts.lockTimeout = false;
    assert.equal(await submitAndWait(t), "success");
    assert.equal(t.be.tab().getLastRow(), 2);
  });
}

test("U15 [page:new backend:new] reply lost after write AND lookups down → retry still adds no duplicate (entryId guard)", async () => {
  const t = await open("new", "new");
  try {
    await login(t.page);
    await fill(t.page);
    t.server.plan.submit = ["abortAfter"];
    t.server.plan.status = ["ok", "abortBefore", "abortBefore", "abortBefore", "abortBefore"]; // confirm lookup ok, then down
    assert.equal(await submitAndWait(t), "alert");
    assert.match(await alertText(t.page), /Could not confirm/);
    t.server.plan.status = [];
    assert.equal(await submitAndWait(t), "success");    // staff retries anyway
    assert.equal(t.be.tab().getLastRow(), 2);           // still one row
  } finally { await t.close(); }
});

test("U16 [page:new backend:new] entryIds are reused for an unchanged retry and survive a reload", async () => {
  const t = await open("new", "new");
  try {
    await login(t.page);
    await fill(t.page);
    t.server.plan.submit = ["abortBefore"];
    assert.equal(await submitAndWait(t), "alert");
    const first = t.server.log.filter((p) => p.action === "submit")[0].entries[0].entryId;
    await t.page.reload();
    await t.page.waitForSelector("#mainSection:not(.hidden)");
    assert.equal(await submitAndWait(t), "success");
    const second = t.server.log.filter((p) => p.action === "submit")[1].entries[0].entryId;
    assert.equal(second, first);
    // a different job gets a fresh id
    await t.page.click("#submitMoreBtn");
    await fill(t.page, [{ venue: "Other Mall" }]);
    assert.equal(await submitAndWait(t), "success");
    const third = t.server.log.filter((p) => p.action === "submit")[2].entries[0].entryId;
    assert.notEqual(third, first);
    assert.equal(t.be.tab().getLastRow(), 3);
  } finally { await t.close(); }
});

test("U17 [page:deployed backend:new] staff with the OLD page cached can still submit and check status after the new Code.gs goes live", async () => {
  const t = await open("deployed", "new");
  try {
    await login(t.page);
    await fill(t.page);
    assert.equal(await submitAndWait(t), "success");
    assert.equal(t.be.tab().getLastRow(), 2);
    await t.page.click("#successStatusBtn");
    await t.page.click("#statusCheckBtn");
    await t.page.waitForSelector(".status-item");
    assert.match(await t.page.textContent("#statusResults"), /Test Mall/);
  } finally { await t.close(); }
});

test("U18 root index.html and deliverables/index.html are byte-identical, and hold no access code", () => {
  const a = fs.readFileSync(path.join(ROOT, "index.html"));
  const b = fs.readFileSync(path.join(ROOT, "deliverables", "index.html"));
  assert.ok(a.equals(b));
  assert.doesNotMatch(a.toString(), /ACCESS_CODE\s*[:=]\s*["']/);
  assert.doesNotMatch(a.toString(), /secret_|ntn_/);           // no Notion key
});
