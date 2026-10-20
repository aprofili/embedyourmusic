// Any cover on the site plays in the side panel while it is open.
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { JSDOM, VirtualConsole } = require("jsdom");
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const html = `<body><div class="chart_item" id="row1">
    <a id="cover" href="/release/album/neurosis/an-undying-love/"><img alt="Cover art for An Undying Love" src="//cdn.sonemic.net/i/150/x/a.jpg"></a>
    <a class="release" href="/release/album/neurosis/an-undying-love/">An Undying Love for a Burning World</a>
    <a class="artist" href="/artist/neurosis">Neurosis</a></div>
    <a id="plain" href="/artist/neurosis">artist</a></body>`;
  const dom = new JSDOM(html, { url: "https://rateyourmusic.com/charts/top/album/2026/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: new VirtualConsole() });
  const w = dom.window;
  w.IntersectionObserver = class { observe() {} unobserve() {} };
  const sent = [];
  w.chrome = { runtime: { sendMessage: async (m) => { sent.push(m); return m.type === "sidebar-play" ? { handled: true } : { open: true }; }, onMessage: { addListener() {} } }, storage: { local: { get: async () => ({}), set: async () => {} } } };
  w.__eymRelease = { getByHref: async (href) => ({ id: "42", rating: 8, ratingKnown: true, links: '{"spotify":{"abc":{"default":true,"type":"album"}}}' }), blocked: () => false };
  w.eval(fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8"));
  const click = (el) => {
    const ev = new w.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    el.dispatchEvent(ev);
    return ev;
  };

  // panel closed: normal navigation
  let ev = click(w.document.getElementById("cover"));
  assert.ok(!ev.defaultPrevented, "closed: link works normally");

  // panel open
  w.document.documentElement.classList.add("eym-sidebar");
  ev = click(w.document.getElementById("cover"));
  assert.ok(ev.defaultPrevented, "open: cover click is taken over");
  await tick(20);
  const play = sent.find((m) => m.type === "sidebar-play");
  assert.ok(play, "sent to the panel");
  const p = JSON.parse(JSON.stringify(play.payload));
  assert.strictEqual(p.title, "An Undying Love for a Burning World");
  assert.strictEqual(p.artist, "Neurosis");
  assert.strictEqual(p.id, "42");
  assert.strictEqual(p.rating, 8);
  assert.strictEqual(p.artUrl, "https://cdn.sonemic.net/i/300/x/a.jpg");
  assert.deepStrictEqual(p.entries, [{ service: "spotify", href: "https://open.spotify.com/album/abc" }]);

  // modified clicks and non-cover links are left alone
  ev = click(w.document.getElementById("plain"));
  assert.ok(!ev.defaultPrevented);
  const m = new w.MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ctrlKey: true });
  w.document.getElementById("cover").dispatchEvent(m);
  assert.ok(!m.defaultPrevented, "ctrl-click opens normally");
  console.log("cover tests passed");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
