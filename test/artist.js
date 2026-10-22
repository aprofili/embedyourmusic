// "More by this artist": the artist page is read for albums only, minus the current one.
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { JSDOM, VirtualConsole } = require("jsdom");
(async () => {
  const html = `<body><div class="disco_release"><a class="album" href="/release/album/neurosis/an-undying-love/">An Undying Love</a></div>
  <div class="disco_release"><a class="album" href="/release/album/neurosis/through-silver-in-blood/">Through Silver in Blood</a></div>
  <div class="disco_release"><a class="album" href="/release/single/neurosis/a-single/">A Single</a></div></body>`;
  const dom = new JSDOM(html, { url: "https://rateyourmusic.com/artist/neurosis", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: new VirtualConsole() });
  const w = dom.window;
  w.IntersectionObserver = class { observe() {} unobserve() {} };
  let handler;
  w.chrome = { runtime: { sendMessage: async () => ({}), onMessage: { addListener: (f) => (handler = f) } }, storage: { local: { get: async () => ({}), set: async () => {} } } };
  w.eval(fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8"));
  const res = await new Promise((r) => handler({ type: "fetch-artist", path: "/artist/neurosis", name: "Neurosis" }, {}, r));
  const items = JSON.parse(JSON.stringify(res.items));
  assert.deepStrictEqual(items.map((i) => i.title), ["An Undying Love", "Through Silver in Blood"]);
  assert.strictEqual(items[0].artist, "Neurosis");
  // The real artist page: Albums only (no "Appears on", singles, compilations), the artist's own name.
  const real = "/root/.claude/uploads/9f0b7094-47c7-58f0-bb8e-5a0c55e1425f/5579e856-attachment.txt";
  if (!process.env.EYM_NO_REAL && fs.existsSync(real)) {
    const d2 = new JSDOM(fs.readFileSync(real, "utf8"), { url: "https://rateyourmusic.com/artist/the-beatles", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: new VirtualConsole() });
    const w2 = d2.window;
    w2.IntersectionObserver = class { observe() {} unobserve() {} };
    let h2;
    w2.chrome = { runtime: { sendMessage: async () => ({}), onMessage: { addListener: (f) => (h2 = f) } }, storage: { local: { get: async () => ({}), set: async () => {} } } };
    w2.eval(fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8"));
    const r2 = await new Promise((r) => h2({ type: "fetch-artist", path: "/artist/the-beatles", name: "x", skip: "/release/album/the-beatles/help/" }, {}, r));
    const it2 = JSON.parse(JSON.stringify(r2.items));
    assert.strictEqual(r2.name, "The Beatles");
    assert.ok(it2.length > 15, "albums (16 minus the current one) plus the EPs shown");
    assert.ok(it2.slice(0, 15).every((i) => /\/release\/album\/the-beatles\//.test(i.href)), "albums first");
    assert.ok(it2.some((i) => /\/release\/ep\/the-beatles\//.test(i.href)), "EPs included");
    assert.ok(it2.every((i) => /\/release\/(album|ep)\/the-beatles\//.test(i.href)), "no singles / appears-on");
  }
  console.log("artist tests passed");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
