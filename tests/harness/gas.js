// Loads a Code.gs file into a Node `vm` context with stand-ins for the Google
// Apps Script services it uses: an in-memory spreadsheet, script/document
// properties, cache, lock, mail, UI alerts, HtmlService/ContentService and a
// fake Notion API (see notion.js). Nothing here talks to Google or Notion.
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { FakeNotion } = require("./notion");

const ROOT = path.resolve(__dirname, "..", "..");
const SOURCES = {
  new: process.env.CODE_GS || path.join(ROOT, "deliverables", "Code.gs"),
  deployed: path.join(__dirname, "..", "fixtures", "Code.deployed.gs"),
};
const SHEET_TZ = "Asia/Hong_Kong";

// ─── Time zones ──────────────────────────────────────────────
function zoneParts(date, tz) {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  const o = {};
  for (const p of f.formatToParts(date)) o[p.type] = p.value;
  return o;
}
// The instant whose wall-clock time in `tz` is y-mo-d h:mi.
function zonedDate(y, mo, d, h, mi, tz) {
  let guess = Date.UTC(y, mo - 1, d, h, mi, 0);
  for (let k = 0; k < 3; k++) {
    const p = zoneParts(new Date(guess), tz);
    const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    guess += Date.UTC(y, mo - 1, d, h, mi, 0) - asUtc;
  }
  return new Date(guess);
}
function formatDate(date, tz, pattern) {
  const p = zoneParts(date, tz);
  const map = { yyyy: p.year, MM: p.month, dd: p.day, HH: p.hour, mm: p.minute, ss: p.second };
  return pattern.replace(/yyyy|MM|dd|HH|mm|ss/g, (t) => map[t]);
}

// ─── In-memory spreadsheet ───────────────────────────────────
const M_FORMULA = /^=IF\(L(\d+)="", F\1, F\1\+L\1\)$/;

class Cell {
  constructor() { this.v = ""; this.f = null; this.fmt = null; this.bg = null; this.checkbox = false; this.dv = null; this.quoted = false; }
}

class Sheet {
  constructor(ss, name) { this.ss = ss; this.name = name; this.rows = []; this.cfRulesCleared = 0; }
  getName() { return this.name; }
  cell(r, c) {
    while (this.rows.length < r) this.rows.push([]);
    const row = this.rows[r - 1];
    while (row.length < c) row.push(new Cell());
    return row[c - 1];
  }
  peek(r, c) { const row = this.rows[r - 1]; return row && row[c - 1]; }
  getLastRow() {
    for (let r = this.rows.length; r >= 1; r--) {
      if (this.rows[r - 1].some((c) => c.f || (c.v !== "" && c.v !== null))) return r;
    }
    return 0;
  }
  getLastColumn() {
    let m = 0;
    this.rows.forEach((row) => row.forEach((c, i) => { if (c.f || c.v !== "") m = Math.max(m, i + 1); }));
    return m;
  }
  getMaxRows() { return Math.max(1000, this.rows.length); }
  getMaxColumns() { return 26; }
  // Mimics what Sheets does with a typed / API-written value.
  write(r, c, value) {
    const cell = this.cell(r, c);
    cell.f = null; cell.quoted = false;
    if (typeof value !== "string") { cell.v = (value === undefined || value === null) ? "" : value; return; }
    if (cell.fmt === "@") { cell.v = value; return; }
    if (value.startsWith("'")) { cell.v = value.slice(1); cell.quoted = true; return; }
    if (value.startsWith("=")) { cell.f = value; cell.v = ""; return; }
    if (/^-?\d+(\.\d+)?$/.test(value)) { cell.v = parseFloat(value); return; }
    // Sheets parses leading + / - text as a formula (live check L2) → error
    if (/^[+\-]/.test(value)) { cell.f = value; cell.v = "#ERROR!"; return; }
    let m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) { cell.v = zonedDate(+m[1], +m[2], +m[3], 0, 0, this.ss.tz); return; }
    m = value.match(/^(\d{1,2}):(\d{2})$/);
    if (m) { cell.v = zonedDate(1899, 12, 30, +m[1], +m[2], this.ss.tz); return; }
    cell.v = value;
  }
  // Display value, evaluating the column M formula like Sheets would.
  read(r, c) {
    const cell = this.peek(r, c);
    if (!cell) return "";
    if (!cell.f) return cell.v;
    const m = cell.f.match(M_FORMULA);
    if (!m) return "#ERROR!";
    const row = +m[1];
    const F = this.read(row, 6), L = this.read(row, 12);
    if (L === "") return F;
    if (typeof F === "number" && typeof L === "number") return F + L;
    return "#VALUE!";
  }
  getRange(a, b, nr, nc) {
    if (typeof a === "string") {
      const m = a.match(/^([A-Z]+)(\d+)$/);
      let col = 0;
      for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
      return new Range(this, +m[2], col, 1, 1);
    }
    return new Range(this, a, b, nr || 1, nc || 1);
  }
  appendRow(values) {
    this.ss.appendCalls++;
    if (this.ss.opts.failAppendAt && this.ss.appendCalls === this.ss.opts.failAppendAt) {
      throw new Error("Service Spreadsheets failed while accessing document");
    }
    const r = this.getLastRow() + 1;
    values.forEach((v, i) => this.write(r, i + 1, v));
  }
  clear() { this.rows = []; }
  clearConditionalFormatRules() { this.cfRulesCleared++; }
  setColumnWidth() { return this; }
  setColumnWidths() { return this; }
  autoResizeColumns() { return this; }
  // Test helper: sort data rows (2..last) by a 1-based column, like Data → Sort range.
  // Relative references in column M move with their row, as in Sheets.
  sortDataRows(col, desc) {
    const last = this.getLastRow();
    const body = this.rows.slice(1, last);
    const key = (row) => { const c = row[col - 1]; const v = c ? c.v : ""; return v instanceof Date ? v.getTime() : v; };
    body.sort((x, y) => (key(x) < key(y) ? -1 : key(x) > key(y) ? 1 : 0) * (desc ? -1 : 1));
    body.forEach((row, i) => {
      const newR = i + 2;
      row.forEach((c) => {
        if (c.f && M_FORMULA.test(c.f)) c.f = c.f.replace(/([FL])\d+/g, "$1" + newR);
      });
    });
    this.rows.splice(1, body.length, ...body);
  }
  // Test helper: plain 2-D array of display values for rows/cols.
  values() {
    const last = this.getLastRow(), cols = Math.max(16, this.getLastColumn());
    const out = [];
    for (let r = 1; r <= last; r++) { const row = []; for (let c = 1; c <= cols; c++) row.push(this.read(r, c)); out.push(row); }
    return out;
  }
  formulas() {
    const out = [];
    this.rows.forEach((row, ri) => row.forEach((c, ci) => { if (c.f) out.push({ r: ri + 1, c: ci + 1, f: c.f }); }));
    return out;
  }
}

class Range {
  constructor(sheet, r, c, nr, nc) { Object.assign(this, { sheet, r, c, nr, nc }); }
  each(fn) { for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) fn(this.r + i, this.c + j, i, j); }
  getValues() {
    const out = [];
    for (let i = 0; i < this.nr; i++) { const row = []; for (let j = 0; j < this.nc; j++) row.push(this.sheet.read(this.r + i, this.c + j)); out.push(row); }
    return out;
  }
  getValue() { return this.sheet.read(this.r, this.c); }
  setValue(v) { this.each((r, c) => this.sheet.write(r, c, v)); return this; }
  setValues(vals) { this.each((r, c, i, j) => this.sheet.write(r, c, vals[i][j])); return this; }
  setFormula(f) {
    const ss = this.sheet.ss;
    ss.formulaCalls++;
    if (ss.opts.failFormulaAt && ss.formulaCalls === ss.opts.failFormulaAt) throw new Error("Service Spreadsheets timed out while accessing document");
    this.each((r, c) => { const cell = this.sheet.cell(r, c); cell.f = f; cell.v = ""; });
    return this;
  }
  setNote(n) { this.each((r, c) => { this.sheet.cell(r, c).note = n; }); return this; }
  setNumberFormat(fmt) { this.each((r, c) => { this.sheet.cell(r, c).fmt = fmt; }); return this; }
  setBackground(bg) { this.each((r, c) => { this.sheet.cell(r, c).bg = bg; }); return this; }
  insertCheckboxes() { this.each((r, c) => { const cell = this.sheet.cell(r, c); cell.checkbox = true; cell.v = false; }); return this; }
  setDataValidation(dv) { this.each((r, c) => { this.sheet.cell(r, c).dv = dv; }); return this; }
  clearDataValidations() { this.sheet.rows.forEach((row) => row.forEach((c) => { c.dv = null; c.checkbox = false; })); return this; }
}
for (const m of ["setFontColor", "setFontWeight", "setHorizontalAlignment", "setFontSize", "mergeAcross",
  "setTextStyle", "setWrapStrategy", "setBorder"]) Range.prototype[m] = function () { return this; };

class Spreadsheet {
  constructor(opts) { this.opts = opts; this.tz = opts.sheetTz || SHEET_TZ; this.sheets = {}; this.appendCalls = 0; this.formulaCalls = 0; this.active = null; }
  getSheetByName(n) { return this.sheets[n] || null; }
  insertSheet(n) { this.sheets[n] = new Sheet(this, n); return this.sheets[n]; }
  setActiveSheet(s) { this.active = s; return s; }
  getActiveSheet() { return this.active; }
  getSpreadsheetTimeZone() { return this.tz; }
}

function chainBuilder(result) {
  const b = new Proxy({}, {
    get(_, prop) {
      if (prop === "build") return () => result;
      return (...args) => { if (prop === "requireValueInList") result.list = args[0]; return b; };
    },
  });
  return b;
}

class PropStore {
  constructor() { this.m = {}; }
  getProperty(k) { return Object.prototype.hasOwnProperty.call(this.m, k) ? this.m[k] : null; }
  setProperty(k, v) { this.m[k] = String(v); return this; }
  deleteProperty(k) { delete this.m[k]; return this; }
  getProperties() { return Object.assign({}, this.m); }
}

// ─── Loader ──────────────────────────────────────────────────
function loadBackend(variant = "new", options = {}) {
  const opts = Object.assign({ accessCode: "test-code", notionKey: "secret_test_key" }, options);
  const ss = new Spreadsheet(opts);
  const tab = ss.insertSheet("Timesheet_Submissions");
  ["Submission Timestamp", "Staff Name", "Phone Number", "Date of Work", "Work Venue", "Basic Rate ($)",
    "Start Time", "End Time", "Notes", "Project No.", "PIC", "OT Compensation", "Final Rate", "Status", "Role", "Synced"]
    .forEach((h, i) => tab.write(1, i + 1, h));

  const scriptProps = new PropStore();
  const docProps = new PropStore();
  if (opts.accessCode) scriptProps.setProperty("ACCESS_CODE", opts.accessCode);
  if (opts.notionKey) scriptProps.setProperty("NOTION_API_KEY", opts.notionKey);

  const ui = {
    alerts: [], dialogs: [], responses: [], menus: [],
    alert(a, b, c) {
      ui.alerts.push(b === undefined ? String(a) : String(a) + "\n" + String(b));
      if (c !== undefined) return ui.responses.length ? ui.responses.shift() : "YES";
      return "OK";
    },
    showModalDialog(out, title) { ui.dialogs.push({ title, html: out.html }); },
    createMenu(name) {
      const menu = { name, items: [] };
      ui.menus.push(menu);
      const api = {
        addItem(label, fn) { menu.items.push({ label, fn }); return api; },
        addSeparator() { return api; },
        addToUi() { return api; },
      };
      return api;
    },
    ButtonSet: { YES_NO: "YES_NO", OK: "OK", OK_CANCEL: "OK_CANCEL" },
    Button: { YES: "YES", NO: "NO", OK: "OK", CANCEL: "CANCEL" },
  };
  const mail = [];
  const cache = new Map();
  const notion = new FakeNotion(opts.notion || {});
  const htmlOutputs = [];
  const logs = [];
  let locked = false;

  const sandbox = {
    console,
    JSON, Math, Date, Object, Array, String, Number, RegExp, Error, parseInt, parseFloat, isNaN, encodeURIComponent, decodeURIComponent,
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ss,
      getUi: () => {
        if (opts.webContext) throw new Error("Cannot call SpreadsheetApp.getUi() from this context.");
        return ui;
      },
      newDataValidation: () => chainBuilder({ kind: "dv" }),
      newTextStyle: () => chainBuilder({ kind: "style" }),
      WrapStrategy: { WRAP: "WRAP", CLIP: "CLIP" },
      BorderStyle: { SOLID: "SOLID" },
    },
    LockService: {
      getScriptLock: () => ({
        waitLock() { if (opts.lockTimeout) throw new Error("Lock timeout: another process was holding the lock for too long."); locked = true; },
        tryLock() { if (opts.lockTimeout) return false; locked = true; return true; },
        releaseLock() { locked = false; },
        hasLock() { return locked; },
      }),
    },
    CacheService: {
      getScriptCache: () => ({
        get: (k) => (cache.has(k) ? cache.get(k) : null),
        put: (k, v) => { cache.set(k, String(v)); },
        remove: (k) => { cache.delete(k); },
      }),
    },
    PropertiesService: { getScriptProperties: () => scriptProps, getDocumentProperties: () => docProps },
    ContentService: {
      createTextOutput: (s) => ({ kind: "text", content: s, mime: "TEXT", setMimeType(m) { this.mime = m; return this; }, getContent() { return this.content; } }),
      MimeType: { JSON: "JSON", TEXT: "TEXT" },
    },
    HtmlService: {
      createHtmlOutput: (html) => { const o = { kind: "html", html, setWidth() { return o; }, setHeight() { return o; } }; htmlOutputs.push(o); return o; },
    },
    Utilities: { formatDate, sleep: () => {} },
    MailApp: { sendEmail: (...args) => { mail.push(args); } },
    Session: { getEffectiveUser: () => ({ getEmail: () => "owner@example.test" }) },
    Logger: { log: (m) => logs.push(String(m)) },
    UrlFetchApp: { fetch: (url, o) => notion.fetch(url, o) },
  };
  const ctx = vm.createContext(sandbox);
  const file = SOURCES[variant] || variant;
  vm.runInContext(fs.readFileSync(file, "utf8"), ctx, { filename: path.basename(file) });
  notion.crewDb = ctx.CREW_DB_ID;
  notion.hiringDb = ctx.HIRING_DB_ID;

  const be = {
    variant, ctx, ss, ui, mail, cache, notion, htmlOutputs, logs, scriptProps, docProps, opts,
    tab: () => ss.getSheetByName("Timesheet_Submissions"),
    sheet: (n) => ss.getSheetByName(n),
    // Call a function by its name in either version ("handleSubmit" finds handleSubmit_ too).
    fn(name) { return ctx[name + "_"] || ctx[name]; },
    call(name, ...args) { return be.fn(name)(...args); },
    post(payload) {
      const out = ctx.doPost({ postData: { contents: JSON.stringify(payload) } });
      return JSON.parse(out.content);
    },
    // Raw body for HTTP-level callers (the Playwright route handler).
    postRaw(body) {
      const out = ctx.doPost({ postData: { contents: body } });
      return out.content;
    },
  };
  return be;
}

module.exports = { loadBackend, formatDate, zonedDate, SHEET_TZ, ROOT };
