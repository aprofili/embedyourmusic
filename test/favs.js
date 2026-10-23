// Favorites page parsing (real collection page if present), similar via hidden list, main bridge, listened tracking.
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { JSDOM, VirtualConsole } = require("jsdom");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const real = "/root/.claude/uploads/9f0b7094-47c7-58f0-bb8e-5a0c55e1425f/f48786cc-attachment.txt";

function page(html, extra = {}) {
  const dom = new JSDOM(html, { url: "https://rateyourmusic.com/recommendations/u/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: new VirtualConsole() });
  const w = dom.window;
  w.IntersectionObserver = class { observe() {} unobserve() {} };
  let listener;
  w.chrome = { runtime: { sendMessage: async () => ({}), onMessage: { addListener: (fn) => (listener = fn) } }, storage: { local: { get: async (k) => ({}), set: async () => {} } } };
  Object.assign(w, extra);
  w.eval(read("release-data.js"));
  w.eval(read("content.js"));
  const ask = (msg) => new Promise((res) => listener(msg, null, res));
  return { w, ask };
}
const header = '<a class="header_profile_main" href="/~jkprilfools"></a>';

(async () => {
  if (!process.env.EYM_NO_REAL && fs.existsSync(real)) {
    const html = fs.readFileSync(real, "utf8");
    const { ask } = page(`<body>${header}</body>`, { fetch: async (u) => { assert.ok(/^\/collection\/jkprilfools\/r3\.5-5\.0(\/2)?$/.test(u), u); return { ok: true, status: 200, text: async () => html }; } });
    const r = await ask({ type: "fetch-favorites", page: 1 });
    assert.ok(r.items && r.items.length >= 10, "items " + JSON.stringify(r).slice(0, 200));
    assert.ok(r.pages >= 4, "pages " + r.pages);
    assert.ok(r.items[0].href.startsWith("https://rateyourmusic.com/release/album/") && r.items[0].artist && r.items[0].title);
    assert.ok(/\/i\/\d+\/w\//.test(r.items[0].artUrl), r.items[0].artUrl); // kept as RYM gave it (per-size hash)
  }

  // Similar loaded without the album page: a hidden list is made, RYM's code (mocked) fills it, it is removed after
  {
    const { w, ask } = page(`<body>${header}</body>`);
    w.document.addEventListener("eym-main", (e) => {
      const { id } = JSON.parse(e.detail);
      const ul = w.document.getElementById(`suggestions_release_${id}`);
      assert.ok(ul);
      ul.innerHTML = '<li><a href="/release/album/x/y/">Y</a> <a class="artist" href="/artist/x">X</a></li>';
    });
    const r = await ask({ type: "load-similar", id: "321" });
    assert.strictEqual(r.items[0].title, "Y");
    assert.ok(!w.document.getElementById("suggestions_release_321"), "temporary list removed");
  }

  // Rating without a widget on the page goes through RYM's own request (via the bridge); check-rating reads the release page
  {
    const { w, ask } = page(`<body>${header}</body>`);
    const events = [];
    w.document.addEventListener("eym-main", (e) => events.push(JSON.parse(e.detail)));
    const r = await ask({ type: "rate", id: "77", rating: 7 });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(r)), { ok: true });
    assert.deepStrictEqual(events, [{ action: "rate", id: "77", rating: 7 }]);
    assert.strictEqual(w.__eymRelease.peek("77").rating, 7, "cache updated");
    w.fetch = async () => ({ ok: true, status: 200, text: async () => "<div data-links='{}'></div>new RYMrating('l', 88, 9 );" });
    const c = await ask({ type: "check-rating", id: "88", href: "https://rateyourmusic.com/release/album/a/b/" });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(c)), { rating: 9, ratingKnown: true });
  }

  // main-bridge: calls RYM's own functions
  {
    const dom = new JSDOM("<head><script src='//cdn.sonemic.net/dist/rym25/js/bundle.js?v=1'></script></head><body><ul id='suggestions_release_5'></ul></body>", { url: "https://rateyourmusic.com/x", runScripts: "outside-only", virtualConsole: new VirtualConsole() });
    const w = dom.window;
    const calls = [];
    w.$ = (el) => el;
    w.RYMsuggestions = { load: (ul) => calls.push(["load", ul.id]) };
    w.rym = { request: { post: (...a) => calls.push(["post", ...a.slice(0, 2)]) } };
    w.eval(read("main-bridge.js"));
    w.document.dispatchEvent(new w.CustomEvent("eym-main", { detail: JSON.stringify({ action: "suggestions", id: "5" }) }));
    w.document.dispatchEvent(new w.CustomEvent("eym-main", { detail: JSON.stringify({ action: "listening", id: "5" }) }));
    w.document.dispatchEvent(new w.CustomEvent("eym-main", { detail: JSON.stringify({ action: "listening", id: "5; drop" }) }));
    w.document.dispatchEvent(new w.CustomEvent("eym-main", { detail: JSON.stringify({ action: "rate", id: "5", rating: 8 }) }));
    w.document.dispatchEvent(new w.CustomEvent("eym-main", { detail: JSON.stringify({ action: "rate", id: "5", rating: 99 }) }));
    assert.deepStrictEqual(JSON.parse(JSON.stringify(calls)), [
      ["load", "suggestions_release_5"],
      ["post", "AddPlayHistoryFromText", { play_str: "[Album5]" }],
      ["post", "CatalogSetRating", { type: "l", assoc_id: "5", rating: 8 }],
    ]);
  }

  // On a release page the "Set listening" box is used (RYMPlayHistory.save), not the request
  {
    const dom = new JSDOM("<body><input id='listening_save_btn'></body>", { url: "https://rateyourmusic.com/release/album/a/b/", runScripts: "outside-only", virtualConsole: new VirtualConsole() });
    const w = dom.window;
    const calls = [];
    w.RYMPlayHistory = { assoc_id: 0, save() { calls.push(["save", this.assoc_id]); } };
    w.rym = { request: { post: (...a) => calls.push(["post", a[0]]) } };
    w.eval(read("main-bridge.js"));
    w.document.dispatchEvent(new w.CustomEvent("eym-main", { detail: JSON.stringify({ action: "listening", id: "16765" }) }));
    assert.deepStrictEqual(JSON.parse(JSON.stringify(calls)), [["save", 16765]]);
  }

  // Listened: 4 different tracks, 20 s each, not paused
  {
    const { w } = page("<body></body>");
    const { trackList } = w.__embedYourMusic;
    // drive watchPlayback through the exported matchTrack/watch via a fake frame
    const rows = [1, 2, 3, 4, 5].map((n) => ({ row: w.document.createElement("div"), t: { id: `T${n}xxxxxxxxxxxxxxxxxxx`, name: `Track ${n}`, number: n, ms: 100000 + n * 7000 } }));
    const frame = w.document.createElement("iframe");
    w.document.body.append(frame);
    let fired = 0;
    // Reach the internal watcher through trackList's compact mode with mocked background replies
    w.chrome.runtime.sendMessage = async (m) => {
      if (m.type === "spotify-status") return { connected: true };
      if (m.type === "spotify-tracks") return { tracks: rows.map((r) => ({ ...r.t, saved: false })) };
      return {};
    };
    const box = trackList({ key: "spotify:album:abc" }, frame, { compact: true, onListened: () => fired++ });
    w.document.body.append(box);
    await tick(10);
    // Clicking the liked count opens the per-song list with a heart each
    const cnt = box.querySelector(".rym-like-count");
    const panel = [...box.querySelectorAll(".rym-tracks-list")].find((p) => !p.querySelector(".rym-embed-msg") && p.hidden !== undefined && p.previousElementSibling && p.previousElementSibling.classList.contains("rym-like-bar"));
    assert.ok(panel.hidden && cnt.textContent === "♥ 0/5");
    cnt.click();
    assert.ok(!panel.hidden);
    assert.strictEqual(panel.querySelectorAll(".rym-heart").length, 5);
    panel.querySelectorAll(".rym-heart")[1].click();
    await tick(5);
    assert.strictEqual(cnt.textContent, "♥ 1/5", "count follows the hearts");
    assert.ok(/2\. Track 2/.test(cnt.title));
    const post = (uri, position, isPaused = false) => {
      const ev = new w.MessageEvent("message", { data: { type: "playback_update", payload: { playingURI: `spotify:track:${uri}`, position, isPaused } }, origin: "https://open.spotify.com", source: frame.contentWindow });
      w.dispatchEvent(ev);
    };
    for (let n = 1; n <= 2; n++) post(`T${n}xxxxxxxxxxxxxxxxxxx`, 25000);
    post("T4xxxxxxxxxxxxxxxxxxx", 10000);
    post("T5xxxxxxxxxxxxxxxxxxx", 25000, true); // paused doesn't count
    assert.strictEqual(fired, 0, "2 tracks heard, one short, one paused");
    post("T4xxxxxxxxxxxxxxxxxxx", 21000);
    assert.strictEqual(fired, 1, "fires at 3 tracks");
    post("T5xxxxxxxxxxxxxxxxxxx", 30000);
    assert.strictEqual(fired, 1, "only once");
  }
  console.log("favs tests passed");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
