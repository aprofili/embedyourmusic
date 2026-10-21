// Real release page (if present locally): top-bar link and cover play button.
const fs = require("fs");
const assert = require("assert");
const { JSDOM, VirtualConsole } = require("jsdom");
const f = "/root/.claude/uploads/9f0b7094-47c7-58f0-bb8e-5a0c55e1425f/e657e977-attachment.txt";
if (process.env.EYM_NO_REAL || !fs.existsSync(f)) { console.log("page tests skipped"); process.exit(0); }
const dom = new JSDOM(fs.readFileSync(f, "utf8"), { runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: new VirtualConsole(), url: "https://rateyourmusic.com/release/album/x/y/" });
const w = dom.window;
w.IntersectionObserver = class { observe() {} unobserve() {} };
w.chrome = { runtime: { sendMessage: async () => ({}), onMessage: { addListener() {} } } };
// homepage trimming (synthetic markup: headings found by text)
{
  const hd = new JSDOM('<body><div id="top">bar</div><div id="main"><div class="a"><h1>Welcome to <b>RYM</b></h1><p>blurb</p></div><div class="stats">1,965,569 Artists</div><div class="row"><div><h2>Featured reviews</h2></div><div><h2>Features</h2></div></div></div></body>', { runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: new VirtualConsole(), url: "https://rateyourmusic.com/" });
  const hw = hd.window;
  hw.IntersectionObserver = class { observe() {} unobserve() {} };
  hw.chrome = { runtime: { sendMessage: async () => ({}), onMessage: { addListener() {} } } };
  hw.eval(fs.readFileSync(__dirname + "/../content.js", "utf8"));
  const gone = [...hw.document.querySelectorAll(".rym-gone")].map((n) => n.className.split(" ")[0]);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(gone)), ["a", "stats"], "homepage trimmed");
  assert.ok(!hw.document.querySelector(".row").classList.contains("rym-gone") && !hw.document.getElementById("top").classList.contains("rym-gone"));
}
(async () => {
w.eval(fs.readFileSync(__dirname + "/../content.js", "utf8"));
const d = w.document;
const nav = d.querySelector(".eym-nav-reco");
assert.ok(nav && nav.getAttribute("href") === "/recommendations/jkprilfools/release/", "nav link");
assert.strictEqual(nav.previousElementSibling.getAttribute("href"), "/lists/");
w.__embedYourMusic.run();
const box = d.querySelector(".media_link_container");
box.innerHTML = '<div><div class="ui_media_links"><a id="spotify" href="https://open.spotify.com/album/49JPEgPvEaFp89xqzeQvF7">s</a></div></div>';
w.__embedYourMusic.run();
// header: title (year) with date tooltip, linked artist beneath, average by the stars, redundant rows gone
const yr = d.querySelector(".album_title .rym-year span[title]");
assert.ok(yr && yr.textContent === "1989" && /October 1989/.test(yr.title), "year tooltip");
const who = d.querySelector(".album_title .rym-title-artist a");
assert.ok(who && who.getAttribute("href") === "/artist/voivod" && who.textContent === "Voivod", "artist link");
assert.ok(/^3\.80 Avg over 5,984 ratings$/.test(d.querySelector(".rym-avg").textContent), d.querySelector(".rym-avg").textContent);
assert.strictEqual(d.querySelectorAll("table.album_info tr.rym-gone").length, 3);
const play = d.querySelector(".page_release_art_frame .rym-art-play");
assert.ok(play, "cover play");
let got = null;
w.chrome.runtime.sendMessage = async (m) => { if (m.type === "sidebar-play") got = m; return { handled: true }; };
play.click();
await new Promise((r) => setTimeout(r, 0));
assert.ok(got && got.payload.entries[0].service === "spotify", "cover click plays");
// everything one release-page fetch can supply
const rel = w.__eymRelease || (w.eval(fs.readFileSync(__dirname + "/../release-data.js", "utf8")), w.__eymRelease);
const meta = rel.extractMeta(new w.DOMParser().parseFromString(fs.readFileSync(f, "utf8"), "text/html"));
assert.strictEqual(meta.title, "Nothingface");
assert.strictEqual(meta.artist, "Voivod");
assert.strictEqual(meta.year, 1989);
assert.ok(/\/i\/300\//.test(meta.art), meta.art);
assert.ok(meta.links && meta.links.includes("spotify"));
console.log("page tests passed");
})().catch((e) => { console.error(e); process.exit(1); });
