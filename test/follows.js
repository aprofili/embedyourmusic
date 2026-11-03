// Spotify follows -> RYM follows (background job), the RYM page readers it uses, and the embed volume scaler.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");
const { JSDOM, VirtualConsole } = require("jsdom");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // ---- background job ----
  {
    const listeners = [];
    const store = { "sp:auth": { access: "A", refresh: "R", expires: Date.now() + 3600e3, scope: "user-library-read user-follow-read" }, "sidebar:user": "me" };
    const followed = new Set(["/artist/already"]);
    const clicks = [];
    const json = (o, status = 200) => ({ ok: status < 300, status, json: async () => o });
    const spotify = async (url) => {
      const u = new URL(url);
      if (u.pathname === "/v1/me/following") {
        return u.searchParams.get("after")
          ? json({ artists: { items: [{ id: "s3", name: "Twin" }, { id: "s4", name: "Nobody Knows" }, { id: "s5", name: "Already" }], cursors: {}, next: null } })
          : json({ artists: { items: [{ id: "s1", name: "Bon Iver" }, { id: "s2", name: "Sigur Rós" }], cursors: { after: "s2" }, next: "x" } });
      }
      if (u.pathname === "/v1/artists/s3/albums") return json({ items: [{ name: "Second Album" }, { name: "Third" }] });
      if (u.pathname.startsWith("/v1/artists/")) return json({ items: [] });
      return json({}, 404);
    };
    const search = {
      "Bon Iver": [{ name: "Bon Iver", path: "/artist/bon-iver" }, { name: "Bon Iver & Friends", path: "/artist/bif" }],
      "Sigur Rós": [{ name: "Sigur Rós", path: "/artist/sigur-ros" }],
      Twin: [{ name: "Twin", path: "/artist/twin" }, { name: "Twin", path: "/artist/twin-2" }],
      "Nobody Knows": [],
      Already: [{ name: "Already", path: "/artist/already" }],
    };
    const answer = async (tabId, msg, created) => {
      const url = created.find((t) => t.id === tabId).url;
      if (msg.type === "artist-search") return { results: search[decodeURIComponent(/searchterm=([^&]*)/.exec(url)[1])] };
      if (msg.type === "fetch-artist") return { items: msg.path === "/artist/twin-2" ? [{ title: "Second Album" }] : [{ title: "Unrelated" }] };
      if (msg.type === "artist-follow") {
        if (followed.has(msg.path)) return { ok: true, already: true };
        clicks.push(msg.path);
        followed.add(msg.path);
        return { ok: true };
      }
      return { error: "?" };
    };
    const created = [];
    const chrome = {
      runtime: { onMessage: { addListener: (f) => listeners.push(f) }, onConnect: { addListener() {} }, getURL: (p) => p, id: "x" },
      storage: {
        local: {
          get: async (k) => (Array.isArray(k) ? Object.fromEntries(k.map((x) => [x, store[x]])) : { [k]: store[k] }),
          set: async (o) => Object.assign(store, JSON.parse(JSON.stringify(o))),
          remove: async (k) => delete store[k],
        },
        onChanged: { addListener() {}, removeListener() {} },
      },
      tabs: {
        query: async () => [],
        create: async ({ url }) => {
          const tab = { id: 100 + created.length, url };
          created.push(tab);
          return tab;
        },
        remove: async () => {},
        sendMessage: async (id, msg) => answer(id, msg, created),
        update: async () => {},
        onActivated: { addListener() {}, removeListener() {} },
      },
      identity: { getRedirectURL: () => "https://x.chromiumapp.org/" },
      action: { setBadgeText() {}, setTitle() {} },
    };
    const ctx = { chrome, console, setTimeout, clearTimeout, setInterval, clearInterval, URL, URLSearchParams, Promise, fetch: spotify, __eymFollowGap: 1 };
    vm.createContext(ctx);
    vm.runInContext(read("background.js"), ctx);
    const ask = (msg) => new Promise((res) => listeners.some((f) => f(msg, {}, res) === true) || res(undefined));

    const st = await ask({ type: "follow-status" });
    assert.ok(st.scopeOk && !st.job);
    const r = await ask({ type: "follow-start" });
    assert.strictEqual(r.count, 5, JSON.stringify(r));
    let job;
    for (let i = 0; i < 400; i++) {
      await tick(25);
      job = store["follow:job"];
      if (job && job.phase === "review") break;
    }
    assert.strictEqual(job.phase, "review", "matching finished");
    const by = (name) => job.items.find((x) => x.sp.name === name);
    assert.strictEqual(by("Bon Iver").status, "matched");
    assert.strictEqual(by("Bon Iver").rym.path, "/artist/bon-iver");
    assert.ok(by("Bon Iver").checked);
    assert.strictEqual(by("Sigur Rós").rym.path, "/artist/sigur-ros");
    assert.strictEqual(by("Twin").status, "matched", "two artists named Twin: told apart by album titles");
    assert.strictEqual(by("Twin").rym.path, "/artist/twin-2");
    assert.strictEqual(by("Nobody Knows").status, "none");
    assert.ok(!by("Nobody Knows").checked);

    // untick Sigur Rós, then follow the rest
    const i = job.items.findIndex((x) => x.sp.name === "Sigur Rós");
    await ask({ type: "follow-set", i, checked: false });
    await ask({ type: "follow-go" });
    for (let k = 0; k < 400; k++) {
      await tick(25);
      job = store["follow:job"];
      if (job.phase === "done") break;
    }
    assert.strictEqual(job.phase, "done");
    assert.deepStrictEqual(clicks.sort(), ["/artist/bon-iver", "/artist/twin-2"]);
    assert.strictEqual(job.items.find((x) => x.sp.name === "Already").done, "already");
    assert.ok(!job.items.find((x) => x.sp.name === "Sigur Rós").done, "unticked: left alone");
    assert.ok(created.every((t) => t.url.endsWith("#eym-helper")), "all work in helper tabs");

    // RYM's IP-block page during the import: it stops, stays stopped, and only a button press restarts it
    await ask({ type: "follow-clear" });
    const prevAnswer = answer;
    const origSend = chrome.tabs.sendMessage;
    chrome.tabs.sendMessage = async (id, msg) => {
      const url = created.find((t) => t.id === id).url;
      if (msg.type === "artist-search" && /Bon%20Iver/.test(url)) return { error: "RYM blocked this IP", blocked: true };
      return origSend(id, msg);
    };
    await ask({ type: "follow-start" });
    for (let k = 0; k < 200; k++) {
      await tick(25);
      if (store["rym:block"]) break;
    }
    await tick(50);
    job = store["follow:job"];
    assert.ok(store["rym:block"], "block noted");
    assert.strictEqual(job.running, false, "stopped");
    assert.ok(/IP-block/.test(job.note));
    assert.strictEqual(job.items.find((x) => x.sp.name === "Bon Iver").status, "pending", "kept for later");
    const before = created.length;
    await tick(200);
    assert.strictEqual(created.length, before, "no further pages loaded");
    chrome.tabs.sendMessage = origSend;
    await ask({ type: "follow-resume" });
    assert.ok(!store["rym:block"], "Resume clears it");
    for (let k = 0; k < 400; k++) {
      await tick(25);
      if (store["follow:job"].phase === "review") break;
    }
    assert.strictEqual(store["follow:job"].phase, "review");
    void prevAnswer;

    // missing scope -> asks to reconnect
    store["sp:auth"].scope = "user-library-read";
    assert.ok(!(await ask({ type: "follow-status" })).scopeOk);
  }

  // ---- RYM page readers ----
  {
    const dom = new JSDOM(`<body><header><a href="/artist/nav-thing">Nav Thing</a></header>
      <table><tr><td><a class="searchpage" href="/artist/bon-iver">Bon Iver</a></td></tr>
      <tr><td><a href="/artist/bon-iver/">Bon Iver</a></td></tr>
      <tr><td><a href="/artist/bon-iver/credits">credits</a></td></tr>
      <tr><td><a href="/artist/bif">Bon Iver &amp; Friends</a></td></tr></table></body>`, { url: "https://rateyourmusic.com/search?searchterm=bon+iver&searchtype=a", runScripts: "outside-only", virtualConsole: new VirtualConsole() });
    const w = dom.window;
    w.IntersectionObserver = class { observe() {} unobserve() {} };
    w.chrome = { runtime: { sendMessage: async () => ({}), onMessage: { addListener() {} } }, storage: { local: { get: async () => ({}), set: async () => {} } } };
    w.eval(read("content.js"));
    const res = JSON.parse(JSON.stringify(w.__embedYourMusic.scrapeArtistResults(w.document)));
    assert.deepStrictEqual(res, [{ name: "Bon Iver", path: "/artist/bon-iver" }, { name: "Bon Iver & Friends", path: "/artist/bif" }]);
    const page = (html) => new JSDOM(`<body>${html}</body>`).window.document;
    assert.strictEqual(w.__embedYourMusic.followState(page('<button class="x">Follow</button>')).state, "follow");
    assert.strictEqual(w.__embedYourMusic.followState(page("<button>Following</button>")).state, "following");
    assert.strictEqual(w.__embedYourMusic.followState(page("<a>Followers</a>")).state, "");
  }

  // ---- volume inside the embed ----
  {
    const dom = new JSDOM("<body><audio></audio></body>", { runScripts: "outside-only" });
    const w = dom.window;
    const orig = Object.getOwnPropertyDescriptor(w.HTMLMediaElement.prototype, "volume");
    w.eval(read("spvolume-main.js"));
    const a = w.document.querySelector("audio");
    const real = () => Math.round(orig.get.call(a) * 100) / 100;
    a.volume = 0.8; // Spotify's own setting
    assert.strictEqual(a.volume, 0.8, "Spotify reads back what it set");
    assert.strictEqual(real(), 0.4, "default 50% halves it");
    w.document.dispatchEvent(new w.CustomEvent("eym-volume", { detail: "25" }));
    assert.strictEqual(real(), 0.2);
    w.document.dispatchEvent(new w.CustomEvent("eym-volume", { detail: "100" }));
    assert.strictEqual(real(), 0.8);
    assert.strictEqual(a.volume, 0.8);
  }
  console.log("follows tests passed");
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
