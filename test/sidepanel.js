// Side panel: renders a played release, rates through the background, lists and history.
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { JSDOM, VirtualConsole } = require("jsdom");
const root = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const dom = new JSDOM(read("sidepanel.html").replace(/<script[^>]*><\/script>/g, ""), {
    runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: new VirtualConsole(),
  });
  const w = dom.window;
  w.IntersectionObserver = class { observe() {} unobserve() {} };
  let onMsg, sent = [];
  const store = {
    "sidebar:lists": { recommended: { t: 1, items: Array.from({ length: 30 }, (_, i) => ({ title: `R${i}`, artist: "A", href: `https://rateyourmusic.com/release/album/a/r${i}/`, artUrl: "" })) },
                       challenge: { t: 1, items: [{ title: "C0", artist: "B", href: "https://rateyourmusic.com/release/album/b/c0/", artUrl: "" }] } },
  };
  w.chrome = {
    runtime: {
      connect: () => ({ onMessage: { addListener: (fn) => (onMsg = fn) }, onDisconnect: { addListener() {} }, postMessage() {} }),
      sendMessage: async (m) => {
        sent.push(m);
        if (m.type === "rate") return { ok: true };
        if (m.type === "to-rym" && m.msg.type === "check-rating") return { rating: 6, ratingKnown: true };
        if (m.type === "to-rym" && m.msg.type === "load-release")
          return { tabId: 9, payload: { id: "77", title: m.msg.item.title, artist: m.msg.item.artist, href: m.msg.item.href, artUrl: "", rating: 0,
            entries: [{ service: "tidal", href: "https://tidal.com/album/35146920" }] } };
        if (m.type === "to-rym" && m.msg.type === "fetch-history") return { items: [] };
        if (m.type === "to-rym" && m.msg.type === "fetch-favorites")
          return { items: [{ title: "F1", artist: "X", href: "https://rateyourmusic.com/release/album/x/f1/", artUrl: "" }] };
        return {};
      },
    },
    storage: { local: { get: async (k) => ({ [k]: store[k] }), set: async (o) => Object.assign(store, o) }, onChanged: { addListener() {} } },
  };
  w.eval(read("content.js"));
  w.eval(read("sidepanel.js"));
  await tick();
  const d = w.document;
  assert.ok(!d.getElementById("empty").hidden);

  onMsg({ type: "play", tabId: 7, payload: {
    id: "123", title: "Album", artist: "Band", artUrl: "", href: "https://rateyourmusic.com/release/album/band/album/", rating: 4,
    entries: [
      { service: "tidal", href: "https://tidal.com/album/35146920" },
      { service: "spotify", href: "https://open.spotify.com/album/49JPEgPvEaFp89xqzeQvF7" },
    ],
  } });
  // RYM link first, then services; Spotify is the default
  const tabs = [...d.querySelectorAll("#tabs > *")];
  assert.deepStrictEqual(tabs.map((t) => t.textContent), ["Spotify", "Tidal"], "no RYM tab: title and artist are the links");
  assert.ok(d.querySelector("#body iframe").src.includes("open.spotify.com/embed/album"));
  assert.strictEqual(d.querySelectorAll("#rating .star.full").length, 2);

  d.querySelectorAll("#rating .star")[3].querySelector("button.r").click(); // 4 stars = 8
  await tick();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(sent.find((m) => m.type === "rate"))), { type: "rate", tabId: 7, id: "123", rating: 8 });
  assert.strictEqual(d.querySelectorAll("#rating .star.full").length, 4);
  onMsg({ type: "rating", id: "123", rating: 3 });
  assert.strictEqual(d.getElementById("rating-note").textContent, "Your rating: 1.5");

  // Rating never read: a Check rating button asks RYM once
  onMsg({ type: "play", tabId: 7, payload: { id: "31", title: "Unk", artist: "U", artUrl: "", href: "https://rateyourmusic.com/release/album/u/u/", rating: 0, ratingKnown: false, entries: [] } });
  assert.ok(d.querySelector("#rating-note button"), "check rating button");
  d.querySelector("#rating-note button").click();
  await tick(5);
  assert.ok(sent.some((m) => m.type === "to-rym" && m.msg.type === "check-rating" && m.msg.id === "31"));

  // No embeds: art and names still show
  onMsg({ type: "play", tabId: 7, payload: { id: "5", title: "Bare", artist: "Nobody", artUrl: "https://x/a.jpg", href: "https://rateyourmusic.com/r/", rating: 0, entries: [] } });
  assert.ok(d.querySelector("#body .fallback img") && d.querySelector("#body .fallback").textContent.includes("Nobody"));

  // History stays empty until you press play in the embed (focus moves into the iframe)
  const head = (k) => d.querySelector(`.acc[data-kind="${k}"] .acc-head`);
  const body = (k) => d.querySelector(`.acc[data-kind="${k}"] .acc-body`);
  head("history").click();
  await tick();
  assert.ok(/listen to will show up|press play/.test(body("history").textContent));
  onMsg({ type: "play", tabId: 7, payload: { id: "9", title: "Played", artist: "P", artUrl: "", href: "https://rateyourmusic.com/release/album/p/p/", rating: 0,
    entries: [{ service: "tidal", href: "https://tidal.com/album/35146920" }] } });
  d.querySelector("#body iframe").focus();
  w.dispatchEvent(new w.Event("blur"));
  await tick(5);
  assert.strictEqual(d.querySelectorAll('.acc[data-kind="history"] .item').length, 1);
  // listening again doesn't duplicate
  onMsg({ type: "play", tabId: 7, payload: { id: "9", title: "Played", artist: "P", artUrl: "", href: "https://rateyourmusic.com/release/album/p/p/", rating: 0,
    entries: [{ service: "tidal", href: "https://tidal.com/album/35146920" }] } });
  d.querySelector("#body iframe").focus();
  w.dispatchEvent(new w.Event("blur"));
  await tick(5);
  assert.strictEqual(store["sidebar:played"].length, 1);

  // Opening one list closes the others; long lists start truncated with Show more
  Object.defineProperty(w, "innerHeight", { value: 400, configurable: true });
  head("recommended").click();
  await tick();
  assert.ok(d.querySelector('.acc[data-kind="recommended"]').classList.contains("open"));
  assert.ok(!d.querySelector('.acc[data-kind="history"]').classList.contains("open"));
  assert.ok(d.querySelectorAll('.acc[data-kind="recommended"] .item').length < 30);
  const more = d.querySelector('.acc[data-kind="recommended"] .more');
  assert.ok(!more.hidden);
  more.click();
  assert.strictEqual(d.querySelectorAll('.acc[data-kind="recommended"] .item').length, 30);

  // Rated rows are dimmed; the X excludes through the recommendations tab and removes the row
  store["sidebar:lists"].recommended.items[0].rated = true;
  store["sidebar:lists"].recommended.items[0].id = "101";
  head("recommended").click(); head("recommended").click(); await tick(); // close + reopen
  assert.ok(d.querySelector('.acc[data-kind="recommended"] .item').classList.contains("rated"));
  const before = d.querySelectorAll('.acc[data-kind="recommended"] .item').length;
  d.querySelector('.acc[data-kind="recommended"] .item .x').click();
  await tick();
  assert.ok(sent.some((m) => m.type === "to-rym" && m.urlPart === "/recommendations/" && m.msg.type === "exclude" && m.msg.id === "101"));
  assert.ok(d.querySelectorAll('.acc[data-kind="recommended"] .item').length <= before);

  // Playing a list item loads it through the RYM tab and plays it here
  d.querySelector('.acc[data-kind="recommended"] .item').click();
  await tick(5);
  assert.strictEqual(d.querySelector("#body a.sp-title").getAttribute("href"), "https://rateyourmusic.com/release/album/a/r1/"); // r0 was excluded
  assert.ok(sent.some((m) => m.type === "to-rym" && m.msg.type === "load-release"));

  // Dice: skips rated entries (list flag), plays a random unrated one
  {
    const items = store["sidebar:lists"].recommended.items;
    items.forEach((it) => (it.rated = true));
    items[5].rated = false;
    sent.length = 0;
    d.querySelector('.acc[data-kind="recommended"] .dice').click();
    await tick(8);
    const loads = sent.filter((m) => m.type === "to-rym" && m.msg.type === "load-release");
    assert.strictEqual(loads.length, 1);
    assert.strictEqual(loads[0].msg.item.href, items[5].href);
  }

  // Favorites fetched once and cached
  head("favorites").click();
  await tick(5);
  assert.strictEqual(d.querySelectorAll('.acc[data-kind="favorites"] .item').length, 1);
  assert.ok(store["sidebar:favs35"] && Object.values(store["sidebar:favs35"].got).flat().length === 1);
  console.log("sidepanel tests passed");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
