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
  console.log("artist tests passed");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
