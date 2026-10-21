// RYM play history page parsing.
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { JSDOM, VirtualConsole } = require("jsdom");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");

const item = (id, href, artist, title, aid, img) => `<div class="play_history_item" id="play_history_item_${id}">
  <div class="play_history_artbox"><a href="${href}"><img class="play_history_item_art" src="${img}"></a></div>
  <div class="play_history_infobox"><div class="play_history_item_date">10/20/2026</div>
   <div class="play_history_infobox_lower"><div class="play_history_item_release">
    <span class="play_history_item_artist"><a title="[Artist1]" href="/artist/x" class="artist">${artist}</a></span>
    <a href="${href}" class="album play_history_item_release" title="[Album${aid}]">${title}</a></div></div></div></div>`;

(async () => {
  const html = `<body><a class="header_profile_main" href="/~jkprilfools"></a><div id="play_history">
    ${item(3, "/release/ep/zach-bryan/yh/", "Zach Bryan", "Young Manhood", 17158983, "//cdn.sonemic.net/i/75/w/abc/15156381")}
    ${item(2, "/release/album/grandaddy/sumday/", "Grandaddy", "Sumday", 42169, "//cdn.sonemic.net/i/75/w/def/1272408")}
    ${item(1, "/release/album/grandaddy/sumday/", "Grandaddy", "Sumday", 42169, "//cdn.sonemic.net/i/75/w/def/1272408")}</div></body>`;
  const dom = new JSDOM(html, { url: "https://rateyourmusic.com/~jkprilfools", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: new VirtualConsole() });
  const w = dom.window;
  w.IntersectionObserver = class { observe() {} unobserve() {} };
  let listener;
  w.chrome = { runtime: { sendMessage: async () => ({}), onMessage: { addListener: (fn) => (listener = fn) } }, storage: { local: { get: async () => ({}), set: async () => {} } } };
  w.fetch = async (u) => {
    assert.strictEqual(u, "/play-history/jkprilfools/");
    return { ok: true, status: 200, text: async () => html };
  };
  w.eval(read("release-data.js"));
  w.eval(read("content.js"));
  const r = await new Promise((res) => listener({ type: "fetch-history" }, null, res));
  assert.strictEqual(r.items.length, 2, "one entry per release");
  assert.deepStrictEqual(JSON.parse(JSON.stringify(r.items[0])), {
    id: "17158983", title: "Young Manhood", artist: "Zach Bryan",
    href: "https://rateyourmusic.com/release/ep/zach-bryan/yh/", artUrl: "https://cdn.sonemic.net/i/75/w/abc/15156381",
  });
  const real = "/root/.claude/uploads/9f0b7094-47c7-58f0-bb8e-5a0c55e1425f/2878dd16-attachment.txt";
  if (!process.env.EYM_NO_REAL && fs.existsSync(real)) {
    const doc = new w.DOMParser().parseFromString(fs.readFileSync(real, "utf8"), "text/html");
    const items = w.__embedYourMusic.scrapeHistory(doc);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(items.map((i) => i.title))), ["Young Manhood and Other Donatable Organs", "Sumday"]);
  }
  console.log("history tests passed");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
