// Side panel: renders a played release, rates through the background, restores history.
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { JSDOM, VirtualConsole } = require("jsdom");
const root = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");

(async () => {
  const dom = new JSDOM(read("sidepanel.html").replace(/<script[^>]*><\/script>/g, ""), {
    runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: new VirtualConsole(),
  });
  const w = dom.window;
  w.IntersectionObserver = class { observe() {} unobserve() {} };
  let onMsg, sent = [];
  const store = {};
  w.chrome = {
    runtime: {
      connect: () => ({ onMessage: { addListener: (fn) => (onMsg = fn) }, onDisconnect: { addListener() {} }, postMessage() {} }),
      sendMessage: async (m) => { sent.push(m); return m.type === "rate" ? { ok: true } : {}; },
    },
    storage: { local: { get: async () => store, set: async (o) => Object.assign(store, o) } },
  };
  w.eval(read("content.js"));
  w.eval(read("sidepanel.js"));
  await new Promise((r) => setTimeout(r, 0));
  const d = w.document;
  assert.ok(!d.getElementById("empty").hidden);

  onMsg({ type: "play", tabId: 7, payload: {
    id: "123", title: "Album", artist: "Band", artUrl: "https://x/a.jpg", href: "https://rym/r/1", rating: 4,
    entries: [
      { service: "spotify", href: "https://open.spotify.com/album/49JPEgPvEaFp89xqzeQvF7" },
      { service: "tidal", href: "https://tidal.com/album/35146920" },
    ],
  } });
  assert.ok(!d.getElementById("now").hidden);
  assert.strictEqual(d.getElementById("title").textContent, "Album");
  assert.strictEqual(d.querySelectorAll("#tabs button").length, 2);
  assert.ok(d.querySelector("#body iframe").src.includes("open.spotify.com/embed/album"));
  assert.strictEqual(d.querySelectorAll("#rating .star.full").length, 2);

  d.querySelectorAll("#rating .star")[3].querySelector("button.r").click(); // 4 stars = 8
  await new Promise((r) => setTimeout(r, 0));
  assert.deepStrictEqual(JSON.parse(JSON.stringify(sent.find((m) => m.type === "rate"))), { type: "rate", tabId: 7, id: "123", rating: 8 });
  assert.strictEqual(d.querySelectorAll("#rating .star.full").length, 4);

  onMsg({ type: "rating", id: "123", rating: 3 });
  assert.strictEqual(d.getElementById("rating-note").textContent, "Your rating: 1.5");
  assert.ok(store["sidebar:history"].length === 1);
  // Newest first; the earlier release is listed under Recently played and replays on click
  const second = { id: "456", title: "Second", artist: "Other", artUrl: "", href: "https://rym/r/2", rating: 0,
    entries: [{ service: "tidal", href: "https://tidal.com/album/35146920" }] };
  onMsg({ type: "play", tabId: 8, payload: second });
  assert.strictEqual(d.getElementById("title").textContent, "Second");
  assert.strictEqual(d.querySelectorAll("#history li").length, 1);
  d.querySelector("#history li").click();
  assert.strictEqual(d.getElementById("title").textContent, "Album");
  console.log("sidepanel tests passed");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
