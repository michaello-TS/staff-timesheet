// A small fake of the Notion API endpoints Code.gs uses. It applies the
// documented limits that matter here:
//  - a page object shows at most 25 items of a relation / rich_text property
//    (relation also says has_more: true); the full list comes from
//    GET pages/{id}/properties/{property_id}, paginated
//  - a text part may hold at most 2000 characters; a property at most 100 parts
//  - a relation update may hold at most 100 links
"use strict";

const PAGE_VIEW_LIMIT = 25;

function richTextFromRequest(arr) {
  return (arr || []).map((t) => ({ type: "text", text: { content: t.text.content }, plain_text: t.text.content }));
}

class FakeNotion {
  constructor(opts) {
    this.opts = Object.assign({ propPageSize: 100 }, opts);
    this.pages = {};
    this.calls = [];
    this.seq = 0;
    this.frozen = null; // when set, database queries answer from this snapshot (stale reads)
  }
  id() { this.seq++; return "page-" + String(this.seq).padStart(4, "0"); }

  // ── seeding helpers for tests ──
  addCrew({ name, phone, workLogParts = [], relations = [] }) {
    const id = this.id();
    this.pages[id] = {
      id, db: this.crewDb,
      props: {
        "Name 姓名": { id: "title", type: "title", title: [{ plain_text: name, text: { content: name } }] },
        "Phone 電話": { id: "ph%3A1", type: "phone_number", phone_number: phone },
        "Status 狀態": { id: "st%3A1", type: "select", select: { name: "Active" } },
        "Work Log 工作記錄": { id: "wl%3A1", type: "rich_text", rich_text: workLogParts.map((s) => ({ type: "text", text: { content: s }, plain_text: s })) },
        "Jobs Assigned 派工記錄": { id: "ja%3A1", type: "relation", relation: relations.map((r) => ({ id: r })) },
      },
    };
    return id;
  }
  addHiring({ title, projectNo, role, client }) {
    const id = this.id();
    this.pages[id] = {
      id, db: this.hiringDb,
      props: {
        "Job Title": { id: "title", type: "title", title: [{ plain_text: title, text: { content: title } }] },
        "Project No. 專案編號": { id: "pn%3A1", type: "rich_text", rich_text: [{ type: "text", text: { content: projectNo }, plain_text: projectNo }] },
        "Role Type": { id: "rt%3A1", type: "select", select: { name: role } },
        "Client / Mall": { id: "cm%3A1", type: "select", select: client ? { name: client } : null },
      },
    };
    return id;
  }
  freeze() { this.frozen = JSON.parse(JSON.stringify(this.pages)); }
  crew(id) { return this.pages[id]; }
  workLog(id) { return this.pages[id].props["Work Log 工作記錄"].rich_text.map((t) => t.plain_text).join(""); }
  workLogParts(id) { return this.pages[id].props["Work Log 工作記錄"].rich_text.map((t) => t.plain_text); }
  relations(id) { return this.pages[id].props["Jobs Assigned 派工記錄"].relation.map((r) => r.id); }
  crewPages() { return Object.values(this.pages).filter((p) => p.db === this.crewDb); }

  // ── what a page object looks like over the API ──
  view(p) {
    const properties = {};
    for (const [name, v] of Object.entries(p.props)) {
      const o = Object.assign({}, v);
      if (v.type === "relation") { o.relation = v.relation.slice(0, PAGE_VIEW_LIMIT); o.has_more = v.relation.length > PAGE_VIEW_LIMIT; }
      if (v.type === "rich_text" || v.type === "title") o[v.type] = v[v.type].slice(0, PAGE_VIEW_LIMIT);
      properties[name] = o;
    }
    return { object: "page", id: p.id, properties };
  }

  matches(p, f) {
    if (f.and) return f.and.every((x) => this.matches(p, x));
    if (f.or) return f.or.some((x) => this.matches(p, x));
    const prop = p.props[f.property];
    if (!prop) return false;
    if (f.phone_number) return prop.phone_number === f.phone_number.equals;
    if (f.select) return !!prop.select && prop.select.name === f.select.equals;
    if (f.rich_text) return prop.rich_text.map((t) => t.plain_text).join("") === f.rich_text.equals;
    return false;
  }

  validate(props) {
    for (const [name, v] of Object.entries(props || {})) {
      if (v.rich_text) {
        if (v.rich_text.length > 100) return `body.properties.${name}.rich_text.length should be ≤ \`100\`, instead was \`${v.rich_text.length}\`.`;
        for (const t of v.rich_text) {
          if (t.text.content.length > 2000) return `body.properties.${name}.rich_text[0].text.content.length should be ≤ \`2000\`, instead was \`${t.text.content.length}\`.`;
        }
      }
      if (v.relation && v.relation.length > 100) return `body.properties.${name}.relation.length should be ≤ \`100\`, instead was \`${v.relation.length}\`.`;
    }
    return null;
  }

  applyProps(page, props) {
    for (const [name, v] of Object.entries(props)) {
      const cur = page.props[name] || { id: "x%3A" + name.length, type: Object.keys(v)[0] };
      if (v.rich_text) { cur.type = "rich_text"; cur.rich_text = richTextFromRequest(v.rich_text); }
      else if (v.title) { cur.type = "title"; cur.title = richTextFromRequest(v.title); }
      else if (v.relation) { cur.type = "relation"; cur.relation = v.relation.map((r) => ({ id: r.id })); }
      else if ("phone_number" in v) { cur.type = "phone_number"; cur.phone_number = v.phone_number; }
      else if (v.select) { cur.type = "select"; cur.select = v.select; }
      page.props[name] = cur;
    }
  }

  // UrlFetchApp.fetch stand-in
  fetch(url, o = {}) {
    const method = (o.method || "get").toLowerCase();
    const body = o.payload ? JSON.parse(o.payload) : null;
    const auth = (o.headers || {}).Authorization;
    const u = new URL(url);
    this.calls.push({ method, url, path: u.pathname, body, auth });
    const ok = (obj) => ({ getResponseCode: () => 200, getContentText: () => JSON.stringify(obj) });
    const fail = (code, msg) => ({ getResponseCode: () => code, getContentText: () => JSON.stringify({ object: "error", status: code, message: msg }) });

    if (u.hostname !== "api.notion.com") return fail(404, "not notion");
    const parts = u.pathname.replace(/^\/v1\//, "").split("/");

    if (parts[0] === "search" && method === "post") {
      return ok({ object: "list", results: Object.values(this.pages).map((p) => this.view(p)), has_more: false });
    }
    if (parts[0] === "databases" && parts[2] === "query" && method === "post") {
      const source = this.frozen || this.pages;
      const results = Object.values(source).filter((p) => p.db === parts[1] && (!body.filter || this.matches(p, body.filter)));
      return ok({ object: "list", results: results.map((p) => this.view(p)), has_more: false });
    }
    if (parts[0] === "pages" && parts.length === 1 && method === "post") {
      const err = this.validate(body.properties);
      if (err) return fail(400, err);
      const id = this.id();
      const page = { id, db: body.parent.database_id, props: {} };
      this.applyProps(page, body.properties);
      if (page.db === this.crewDb) {
        if (!page.props["Work Log 工作記錄"]) page.props["Work Log 工作記錄"] = { id: "wl%3A1", type: "rich_text", rich_text: [] };
        if (!page.props["Jobs Assigned 派工記錄"]) page.props["Jobs Assigned 派工記錄"] = { id: "ja%3A1", type: "relation", relation: [] };
      }
      this.pages[id] = page;
      return ok(this.view(page));
    }
    const page = this.pages[parts[1]];
    if (parts[0] === "pages" && !page) return fail(404, "Could not find page");
    if (parts[0] === "pages" && parts.length === 2 && method === "patch") {
      const err = this.validate(body.properties);
      if (err) return fail(400, err);
      this.applyProps(page, body.properties);
      return ok(this.view(page));
    }
    if (parts[0] === "pages" && parts.length === 2 && method === "get") return ok(this.view(page));
    if (parts[0] === "pages" && parts[2] === "properties" && method === "get") {
      const propId = decodeURIComponent(parts[3]);
      const prop = Object.values(page.props).find((p) => decodeURIComponent(p.id) === propId);
      if (!prop) return fail(404, "Could not find property");
      const all = prop.type === "relation"
        ? prop.relation.map((r) => ({ object: "property_item", type: "relation", relation: { id: r.id } }))
        : prop[prop.type].map((t) => ({ object: "property_item", type: prop.type, [prop.type]: t }));
      const size = Math.min(+(u.searchParams.get("page_size") || 100), 100, this.opts.propPageSize);
      const start = +(u.searchParams.get("start_cursor") || 0);
      const slice = all.slice(start, start + size);
      const more = start + size < all.length;
      return ok({ object: "list", results: slice, has_more: more, next_cursor: more ? String(start + size) : null });
    }
    return fail(400, "unsupported " + method + " " + u.pathname);
  }
}

module.exports = { FakeNotion };
