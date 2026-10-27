// RYM gateway (background.js): your open tab first, else one helper tab at a time, always closed afterwards.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function load({ tabs = [], answer, user = "me", activeNow = () => [{ id: 1, windowId: 1 }], stall }) {
  const listeners = [];
  const created = [];
  const removed = [];
  const updates = [];
  let open = 0;
  let maxOpen = 0;
  const store = { "sidebar:user": user };
  const chrome = {
    runtime: { onMessage: { addListener: (f) => listeners.push(f) }, onConnect: { addListener() {} }, getURL: (p) => p, id: "x" },
    storage: { local: { get: async (k) => ({ [k]: store[k] }), set: async (o) => Object.assign(store, o) }, onChanged: { addListener() {}, removeListener() {} } },
    tabs: {
      query: async (q) => (q && q.active ? activeNow(q) : tabs),
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
      update: async (id, props) => updates.push([id, props]),
      onActivated: { addListener() {}, removeListener() {} },
    },
    action: { setBadgeText() {}, setTitle() {} },
  };
  const ctx = { chrome, console, setTimeout, clearTimeout, setInterval, clearInterval, URL, Promise, fetch: async () => ({ ok: false }) };
  vm.createContext(ctx);
  if (stall) ctx.__eymRateStall = stall;
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8"), ctx);
  const ask = (msg) => new Promise((res) => listeners.some((f) => f(msg, {}, res) === true) || res(undefined));
  return { ask, created, removed, updates, stats: () => ({ maxOpen }) };
}

(async () => {
  // 0. Rating: your open album tab never answers -> the album's page is opened in a helper tab, rated there, closed
  {
    const href = "https://rateyourmusic.com/release/album/a/b/";
    const g = load({
      stall: 150,
      tabs: [{ id: 5, url: href, status: "complete", active: false }],
      answer: (id, msg) => (id === 5 ? new Promise(() => {}) : Promise.resolve({ ok: true })),
    });
    const r = await g.ask({ type: "rate", tabId: 5, id: "9", rating: 8, href });
    assert.ok(r.ok, JSON.stringify(r));
    assert.strictEqual(g.created.length, 1, "helper tab opened for the retry");
    assert.ok(g.created[0].url.includes("/release/album/a/b/") && g.created[0].url.includes("eym-helper"));
    await tick(50);
    assert.strictEqual(g.removed.length, 1, "and closed again");
  }
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
  // 5. Closing the helper tab sends you back to the tab you were on (Edge picks another one otherwise).
  {
    let calls = 0;
    const g = load({ answer: async () => ({ items: [{ title: "X" }] }), activeNow: () => (calls++ === 0 ? [{ id: 1, windowId: 1 }] : [{ id: 7, windowId: 1 }]) });
    await g.ask({ type: "to-rym", msg: { type: "fetch-newmusic" } });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(g.updates)), [[1, { active: true }]]);
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
  // 6. Clicking on to another album drops the older request (it would otherwise hold up the queue for 30 s).
  {
    const g = load({ answer: async (id, msg) => (msg.item.seq === 1 ? { pending: true } : { payload: { id: "2" } }) });
    const a = g.ask({ type: "to-rym", seq: 1, msg: { type: "load-release", item: { href: "/release/album/a/one/", seq: 1 } } });
    await tick(900);
    const b = g.ask({ type: "to-rym", seq: 2, msg: { type: "load-release", item: { href: "/release/album/a/two/", seq: 2 } } });
    const [ra, rb] = await Promise.all([a, b]);
    assert.ok(/superseded/.test(ra.error), "older request abandoned");
    assert.strictEqual(rb.payload.id, "2");
    assert.strictEqual(g.stats().maxOpen, 1);
  }
  // 7. Play history goes out once per album change: a, a -> once; a, b, a -> three times
  {
    const sets = [];
    const g = load({ answer: async (id, msg) => (msg.type === "set-listening" ? (sets.push(msg.id), { ok: true }) : { ok: true }) });
    const heard = (rymId) => g.ask({ type: "eng-state", event: "listened", state: { rymId, href: `/release/album/a/${rymId}/`, title: rymId } });
    heard("1");
    heard("1"); // both signals at once
    await tick(2000);
    heard("1"); // and again later
    await tick(300);
    assert.deepStrictEqual(sets, ["1"], "same album twice in a row: one send");
    heard("2");
    heard("2");
    await tick(2000);
    heard("1");
    await tick(2000);
    assert.deepStrictEqual(sets, ["1", "2", "1"], "sent again once another album was in between; never doubled");
  }
  // 8. A send that fails is queued and goes out first, in order, once RYM answers again
  {
    let broken = true;
    const g = load({ answer: async (id, msg) => (msg.type !== "set-listening" ? { ok: true } : broken ? { error: "RYM is down" } : { ok: true }) });
    const opened = () => g.created.map((c) => /album\/a\/(\d)\//.exec(c.url)[1]).join("");
    const heard = (rymId) => g.ask({ type: "eng-state", event: "listened", state: { rymId, href: `/release/album/a/${rymId}/`, title: `T${rymId}` } });
    heard("1");
    await tick(7500); // the helper gives up on an erroring page after about 5 s
    assert.strictEqual(opened(), "1", "tried once, failed");
    broken = false;
    heard("2");
    await tick(3500);
    assert.strictEqual(opened(), "112", "the failed one goes first (retry), then the new one");
    heard("3");
    await tick(2000);
    assert.strictEqual(opened(), "1123", "queue was emptied");
  }
  console.log("gateway tests passed");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
