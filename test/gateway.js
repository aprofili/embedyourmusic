// RYM gateway (background.js): your open tab first, else one helper tab at a time, always closed afterwards.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function load({ tabs = [], answer, user = "me" }) {
  const listeners = [];
  const created = [];
  const removed = [];
  let open = 0;
  let maxOpen = 0;
  const store = { "sidebar:user": user };
  const chrome = {
    runtime: { onMessage: { addListener: (f) => listeners.push(f) }, onConnect: { addListener() {} }, getURL: (p) => p, id: "x" },
    storage: { local: { get: async (k) => ({ [k]: store[k] }), set: async (o) => Object.assign(store, o) }, onChanged: { addListener() {}, removeListener() {} } },
    tabs: {
      query: async () => tabs,
      create: async ({ url }) => {
        const tab = { id: 100 + created.length, url, status: "loading", born: Date.now() };
        created.push(tab);
        open++;
        maxOpen = Math.max(maxOpen, open);
        return tab;
      },
      remove: async (id) => {
        removed.push(id);
        open--;
      },
      sendMessage: async (id, msg) => answer(id, msg, created),
    },
    action: { setBadgeText() {}, setTitle() {} },
  };
  const ctx = { chrome, console, setTimeout, clearTimeout, setInterval, clearInterval, URL, Promise, fetch: async () => ({ ok: false }) };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8"), ctx);
  const ask = (msg) => new Promise((res) => listeners.some((f) => f(msg, {}, res) === true) || res(undefined));
  return { ask, created, removed, stats: () => ({ maxOpen }) };
}

(async () => {
  // 1. A tab you have open on the page answers; nothing is opened.
  {
    const g = load({ tabs: [{ id: 5, url: "https://rateyourmusic.com/new-music/", status: "complete", active: false }], answer: async (id) => (id === 5 ? { items: [{ title: "A" }] } : undefined) });
    const r = await g.ask({ type: "to-rym", msg: { type: "fetch-newmusic" } });
    assert.strictEqual(r.items[0].title, "A");
    assert.strictEqual(g.created.length, 0, "no helper tab");
  }
  // 2. No such tab: one helper tab on that page (marked), asked until it answers, then closed.
  {
    let asks = 0;
    const g = load({ answer: async (id, msg, created) => {
      asks++;
      if (asks < 2) throw new Error("no receiver yet");
      return { items: [{ title: "H" }] };
    } });
    const r = await g.ask({ type: "to-rym", msg: { type: "fetch-history" } });
    assert.strictEqual(r.items[0].title, "H");
    assert.strictEqual(g.created[0].url, "https://rateyourmusic.com/play-history/me/#eym-helper");
    assert.deepStrictEqual(g.removed, [g.created[0].id], "closed afterwards");
  }
  // 3. Several jobs: helper tabs one at a time; identical jobs share one tab.
  {
    const g = load({ answer: async () => ({ items: [{ title: "X" }], pages: 1 }) });
    await Promise.all([
      g.ask({ type: "to-rym", msg: { type: "fetch-newmusic" } }),
      g.ask({ type: "to-rym", msg: { type: "fetch-newmusic" } }),
      g.ask({ type: "to-rym", msg: { type: "fetch-favorites", page: 2 } }),
    ]);
    assert.strictEqual(g.created.length, 2, "duplicate job shared");
    assert.strictEqual(g.stats().maxOpen, 1, "never two helper tabs at once");
    assert.strictEqual(g.created[1].url, "https://rateyourmusic.com/collection/me/r3.5-5.0/2/#eym-helper");
    assert.strictEqual(g.removed.length, 2);
  }
  // 4. A tab from before an extension reload (no answer) falls through to a helper tab.
  {
    const g = load({ tabs: [{ id: 5, url: "https://rateyourmusic.com/", status: "complete", active: true }], answer: async (id) => {
      if (id === 5) throw new Error("Could not establish connection");
      return { ok: true };
    } });
    const r = await g.ask({ type: "to-rym", msg: { type: "set-listening", id: "1" } });
    assert.ok(r.ok);
    assert.strictEqual(g.created.length, 1);
  }
  console.log("gateway tests passed");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
