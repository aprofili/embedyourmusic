// History tab lists only plays from here (newest first), independent of RYM's own play history.
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { JSDOM, VirtualConsole } = require("jsdom");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const asked = [];
  const dom = new JSDOM(read("sidepanel.html").replace(/<script[^>]*><\/script>/g, ""), { runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: new VirtualConsole() });
  const w = dom.window;
  w.IntersectionObserver = class { observe() {} unobserve() {} };
  const now = Date.now();
  const h = (n) => `https://rateyourmusic.com/release/album/a/${n}/`;
  const store = {
    "sidebar:rymhist": { t: now - 60e3, items: ["X", "Y", "Z"].map((n) => ({ title: n, artist: "a", href: h(n), artUrl: "" })) },
    "sidebar:played": [
      { title: "Z", artist: "a", href: h("Z"), artUrl: "", at: now },
      { title: "Old", artist: "a", href: h("Old"), artUrl: "", at: now - 3600e3 },
    ],
    "sidebar:art-ok": { [h("X")]: "https://i.scdn.co/image/x" },
    "sidebar:art-fix": 1,
    "sidebar:lists": { recommended: { t: now, items: ["R1", "R2", "R3"].map((n, i) => ({ id: String(500 + i), title: n, artist: "b", href: h(n), artUrl: n === "R3" ? "https://e.snmc.io/i/300/s/abc/1.jpg" : "" })) }, challenge: { t: now, items: [] } },
    "sidebar:ratings": { [`p:/release/album/a/R1/`]: 7, "https://rateyourmusic.com/release/album/a/R2/": 0, "i:502": 6 },
  };
  w.chrome = {
    runtime: {
      connect: () => ({ onMessage: { addListener() {} }, onDisconnect: { addListener() {} }, postMessage() {} }),
      sendMessage: async (m) => (asked.push(m), m.type === "cover-art" ? { url: "https://i.scdn.co/image/real" } : {}),
    },
    storage: { local: { get: async (k) => ({ [k]: store[k] }), set: async (o) => Object.assign(store, o) }, onChanged: { addListener: (f) => (w.__changed = f) } },
  };
  w.eval(read("content.js"));
  w.eval(read("sidepanel.js"));
  await tick(20);
  w.document.querySelector('.acc[data-kind="history"] .acc-head').click();
  await tick(20);
  const rows = [...w.document.querySelectorAll('.acc[data-kind="history"] .item')];
  assert.deepStrictEqual(rows.map((r) => r.querySelector(".t").textContent), ["Z", "Old"], "only plays from here, not RYM's history");
  // Ratings seen anywhere grey out list rows (by release path or id), and live when a page reports a new one
  w.document.querySelector('.acc[data-kind="recommended"] .acc-head').click();
  await tick(20);
  const rated = () => [...w.document.querySelectorAll('.acc[data-kind="recommended"] .item')].map((r) => r.classList.contains("rated"));
  assert.deepStrictEqual(rated(), [true, false, true]);
  w.__changed({ "sidebar:ratings": { newValue: { "i:501": 9 } } });
  assert.deepStrictEqual(rated(), [true, true, true], "greyed as soon as a rating is seen");
  // A cover that "loads" as a 1px lazy-load placeholder is a failure: the panel asks for another cover (Spotify's)
  {
    const img = [...w.document.querySelectorAll('.acc[data-kind="recommended"] .item img')][2];
    asked.length = 0;
    Object.defineProperty(img, "naturalWidth", { value: 1, configurable: true });
    Object.defineProperty(img, "naturalHeight", { value: 1, configurable: true });
    img.dispatchEvent(new w.Event("load"));
    await tick(10);
    assert.ok(asked.some((m) => m.type === "cover-art"), "placeholder image triggers a cover lookup");
    assert.strictEqual(img.src, "https://i.scdn.co/image/real");
  }
  console.log("history order tests passed");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
