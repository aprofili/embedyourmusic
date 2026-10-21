// History order (played again -> top, even if RYM's history has it lower) and remembered covers.
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { JSDOM, VirtualConsole } = require("jsdom");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

(async () => {
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
  };
  w.chrome = {
    runtime: {
      connect: () => ({ onMessage: { addListener() {} }, onDisconnect: { addListener() {} }, postMessage() {} }),
      sendMessage: async () => ({}),
    },
    storage: { local: { get: async (k) => ({ [k]: store[k] }), set: async (o) => Object.assign(store, o) }, onChanged: { addListener() {} } },
  };
  w.eval(read("content.js"));
  w.eval(read("sidepanel.js"));
  await tick(20);
  w.document.querySelector('.acc[data-kind="history"] .acc-head').click();
  await tick(20);
  const rows = [...w.document.querySelectorAll('.acc[data-kind="history"] .item')];
  assert.deepStrictEqual(rows.map((r) => r.querySelector(".t").textContent), ["Z", "X", "Y", "Old"]);
  assert.strictEqual(rows[1].querySelector("img").getAttribute("src"), "https://i.scdn.co/image/x", "remembered cover used");
  console.log("history order tests passed");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
