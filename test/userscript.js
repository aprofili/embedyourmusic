// Runs the generated iOS userscript on a mobile-structured page.
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { JSDOM, VirtualConsole } = require("jsdom");

const root = path.join(__dirname, "..");
require("child_process").execFileSync("node", [path.join(root, "build.js")], { stdio: "ignore" });
const src = fs.readFileSync(path.join(root, "dist/userscript/embedyourmusic.user.js"), "utf8");

assert.ok(src.startsWith("// ==UserScript=="));
assert.ok(/@match\s+\*:\/\/rateyourmusic\.com\/\*/.test(src));
assert.ok(!src.includes("globalThis.browser ??"));

const html = `<!doctype html><html><head></head><body><div class="release_page">
 <div class="media_link_container"><div><div class="ui_media_links">
   <a href="https://open.spotify.com/album/49JPEgPvEaFp89xqzeQvF7">s</a>
   <a href="https://voivod.bandcamp.com/album/nothingface">b</a>
 </div></div></div>
 <div class="section_outer section_issues"><div class="release_page_header">Issues</div><p>x</p></div>
 <div class="show-for-small"><div class="section_credits"><div class="release_page_header">Credits</div><p>c</p></div>
 <div class="section_tracklisting"><div class="release_page_header">Tracklist</div><p>t</p></div></div>
</div></body></html>`;

(async () => {
  const dom = new JSDOM(html, { runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: new VirtualConsole() });
  const w = dom.window;
  w.IntersectionObserver = class { constructor(cb) { this.cb = cb; } observe(t) { this.cb([{ isIntersecting: true, target: t }]); } unobserve() {} };
  const reqs = [];
  w.GM_xmlhttpRequest = (o) => {
    reqs.push(o.url);
    setTimeout(() => o.onload({ responseText: `<meta property="og:video" content="https://bandcamp.com/EmbeddedPlayer/v=2/album=999/size=large/tracklist=false/">` }), 0);
  };
  w.eval(src);
  const tick = () => new Promise((r) => setTimeout(r, 20));
  await tick();

  assert.ok(w.document.documentElement.classList.contains("eym-ready"), "release page revealed");
  const cont = w.document.querySelector(".media_link_container");
  assert.ok(cont.classList.contains("rym-has-tabs"));
  assert.ok(w.document.querySelector("iframe[src*='open.spotify.com/embed']"), "spotify default");
  assert.ok(w.document.querySelector(".rym-embed-panel"));
  assert.ok(w.document.querySelector("style").textContent.includes(".rym-has-tabs"));

  // Bandcamp tab goes through GM_xmlhttpRequest
  const tabs = [...w.document.querySelectorAll(".rym-tab")];
  tabs.find((t) => t.href.includes("bandcamp")).dispatchEvent(new w.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
  await tick();
  assert.deepStrictEqual(reqs, ["https://voivod.bandcamp.com/album/nothingface"]);
  assert.ok(w.document.querySelector("iframe[src*='album=999']"), "bandcamp via GM");

  // Mobile section copies get collapse toggles
  for (const sel of [".section_outer.section_issues", ".section_credits", ".section_tracklisting"]) {
    const el = w.document.querySelector(sel);
    const toggle = el.previousElementSibling;
    assert.ok(toggle && toggle.classList.contains("rym-collapse-toggle"), sel + " toggle");
    assert.ok(w.getComputedStyle(el).display === "none", sel + " collapsed");
    toggle.click();
    assert.notStrictEqual(w.getComputedStyle(el).display, "none", sel + " expands");
  }
  console.log("userscript tests passed");
})().catch((e) => { console.error(e); process.exit(1); });
