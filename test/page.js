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
const play = d.querySelector(".page_release_art_frame .rym-art-play");
assert.ok(play, "cover play");
let got = null;
w.chrome.runtime.sendMessage = async (m) => { if (m.type === "sidebar-play") got = m; return { handled: true }; };
play.click();
await new Promise((r) => setTimeout(r, 0));
assert.ok(got && got.payload.entries[0].service === "spotify", "cover click plays");
console.log("page tests passed");
})().catch((e) => { console.error(e); process.exit(1); });
