// Scraping album lists (suggestions, favorites) and loading a release by URL.
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { JSDOM, VirtualConsole } = require("jsdom");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const html = `<html class="page_release"><body>
   <div class="section_suggestions"><ul class="suggestions" data-assoc-id="16765">
     <li><a href="/release/album/a/one/"><img src="//cdn.sonemic.net/i/150/x/one.jpg"></a>
         <a href="/release/album/a/one/">One</a> <a class="artist" href="/artist/a">Artist A</a></li>
     <li><a href="/release/album/b/two/">Two</a> <a class="artist" href="/artist/b">Artist B</a></li>
     <li><a href="/release/album/me/self/">Self</a> <a class="artist" href="/artist/me">Me</a></li>
     <li><a href="/artist/c">not a release</a></li>
   </ul></div></body></html>`;
  const dom = new JSDOM(html, { url: "https://rateyourmusic.com/release/album/me/self/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: new VirtualConsole() });
  const w = dom.window;
  w.IntersectionObserver = class { observe() {} unobserve() {} };
  const store = {};
  w.chrome = { runtime: { sendMessage: async () => ({}), onMessage: { addListener() {} } },
    storage: { local: { get: async (k) => ({ [k]: store[k] }), set: async (o) => Object.assign(store, o) } } };
  w.eval(read("content.js"));
  await tick(20);
  const sim = store["sidebar:similar"] && store["sidebar:similar"]["16765"];
  assert.ok(sim, "similar saved");
  assert.deepStrictEqual(JSON.parse(JSON.stringify(sim.items.map((i) => [i.title, i.artist, i.href]))), [
    ["One", "Artist A", "https://rateyourmusic.com/release/album/a/one/"],
    ["Two", "Artist B", "https://rateyourmusic.com/release/album/b/two/"],
  ]);
  assert.strictEqual(sim.items[0].artUrl, "https://cdn.sonemic.net/i/300/x/one.jpg");
  // Recommendations-style row: lazy <picture> cover (placeholder src) with our ▶ over it, then the title link
  {
    const box = w.document.createElement("div");
    box.innerHTML = `<li class="component_discography_item"><a class="component_discography_item_image_link" href="/release/album/x/y/"><picture>
      <source type="image/webp" data-srcset="//e.snmc.io/i/300/w/aaa/1/c.webp 2x, //e.snmc.io/i/150/w/aaa/1/c.webp 1x">
      <source type="image/jpeg" data-srcset="//e.snmc.io/i/300/s/bbb/1/c.jpeg 2x, //e.snmc.io/i/150/s/bbb/1/c.jpeg 1x">
      <img src="data:image/png;base64,AAAA"></picture><span class="rym-play">▶</span></a>
      <a class="component_discography_item_link release" href="/release/album/x/y/">Real Title</a><a class="artist" href="/artist/x">X</a></li>`;
    const [it] = w.__embedYourMusic.scrapeReleases(box, 1);
    assert.strictEqual(it.title, "Real Title");
    assert.strictEqual(it.artUrl, "https://e.snmc.io/i/300/s/bbb/1/c.jpeg");
  }
  console.log("lists tests passed");
})().catch((e) => { console.error(e); process.exit(1); });
