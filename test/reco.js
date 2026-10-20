// Recommendations page: run against the real page source if present, else a small mock.
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { JSDOM, VirtualConsole } = require("jsdom");

const root = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");
const real = "/root/.claude/uploads/9f0b7094-47c7-58f0-bb8e-5a0c55e1425f/06783218-attachment.txt";
const html = (!process.env.EYM_NO_REAL && fs.existsSync(real))
  ? fs.readFileSync(real, "utf8")
  : `<html class="page_recommendations"><body><div id="page_sections_recommendations"><group id="page_recommendations_group_main_left"><ol>${[1, 2, 3]
      .map((n) => `<li id="component_discography_item_${n}" class="component_discography_item"><a class="component_discography_item_image_link" href="/release/a/b/${n}/"><picture></picture></a><div class="component_discography_item_info"><div class="component_discography_item_info_inner"><a class="component_discography_item_link release" href="/release/a/b/${n}/">T${n}</a><a class="artist" href="/artist/b">B</a></div></div><span class="component_discography_item_details_average">3.87</span><span class="component_discography_item_details_ratings"><span class="full">3,197</span></span><div class="component_discography_item_exclude">x</div></li>`)
      .join("")}</ol></group></div></body></html>`;

const links = {
  spotify: { "49JP": { default: true, type: "album" } },
  applemusic: { 577: { default: true, album: "x", loc: "ca" } },
  bandcamp: { x: { url: "voivod.bandcamp.com/album/nothingface" } },
  qobuz: { q: { default: true } },
};
const releasePage = `<div data-links='${JSON.stringify(links)}'></div>`;

(async () => {
  const dom = new JSDOM(html, { url: "https://rateyourmusic.com/recommendations/u/release/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: new VirtualConsole() });
  const w = dom.window;
  w.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });
  w.IntersectionObserver = class { observe() {} unobserve() {} };
  const fetched = [];
  w.fetch = async (u) => { fetched.push(u); return { ok: true, text: async () => releasePage }; };
  w.chrome = { runtime: { sendMessage: async () => ({ embed: { src: "https://bandcamp.com/EmbeddedPlayer/album=9/", height: 120 } }) } };
  w.__eymGapMs = 0;
  w.eval(read("content.js"));
  w.eval(read("release-data.js"));
  w.eval(read("recommendations.js"));
  const d = w.document;
  const lis = d.querySelectorAll("li.component_discography_item");
  assert.ok(lis.length > 0);
  assert.strictEqual(d.querySelectorAll(".rym-play").length, lis.length, "play button per row");
  assert.ok(d.querySelector(".rym-reco-stats").textContent.startsWith("★ "));
  assert.ok(d.querySelector("#rym-reco-player"));
  assert.ok(d.getElementById("page_sections_recommendations").classList.contains("rym-reco"));

  const tick = () => new Promise((r) => setTimeout(r, 20));
  assert.ok(!d.documentElement.classList.contains("eym-ready"), "page stays covered until the scan finishes");
  assert.ok(!d.querySelector(".rym-reco-current"), "nothing preselected without a marked row");
  d.querySelectorAll("li.component_discography_item")[1].setAttribute("data-eym-first-unrated", "");
  d.dispatchEvent(new w.Event("eym-first-unrated"));
  await tick();
  assert.strictEqual(d.querySelector(".rym-reco-current"), d.querySelectorAll("li.component_discography_item")[1], "first unrated auto-loads");
  assert.ok(d.querySelector(".rym-reco-body iframe[src*='open.spotify.com']"));
  d.dispatchEvent(new w.Event("eym-scan-done"));
  await tick();
  assert.ok(d.documentElement.classList.contains("eym-ready"), "revealed after scan + first album");
  fetched.length = 0;
  const ev = new w.MouseEvent("click", { bubbles: true, cancelable: true });
  d.querySelector("a.component_discography_item_image_link").dispatchEvent(ev);
  assert.ok(ev.defaultPrevented, "navigation suppressed");
  await tick();
  assert.ok(fetched[0].startsWith("/release/"));
  assert.ok(d.querySelector(".rym-reco-body iframe[src*='open.spotify.com/embed/album/49JP']"), "spotify default");
  const labels = [...d.querySelectorAll(".rym-reco-tab")].map((b) => b.textContent);
  assert.deepStrictEqual(labels, ["Spotify", "Apple Music", "Bandcamp"]);
  assert.ok(d.querySelector(".rym-reco-title").textContent.includes("—"));

  [...d.querySelectorAll(".rym-reco-tab")][2].click();
  await tick();
  assert.ok(d.querySelector(".rym-reco-body iframe[src*='album=9']"), "bandcamp tab");
  [...d.querySelectorAll(".rym-reco-tab")][0].click();
  assert.strictEqual(d.querySelectorAll(".rym-reco-body iframe").length, 2, "slots kept");

  const mod = new w.MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true });
  d.querySelector("a.component_discography_item_image_link").dispatchEvent(mod);
  assert.ok(!mod.defaultPrevented, "ctrl-click still navigates");
  d.querySelector("a.component_discography_item_image_link").dispatchEvent(new w.MouseEvent("click", { bubbles: true, cancelable: true }));
  await tick();
  assert.strictEqual(fetched.length, 1, "release page fetched once per release");
  console.log(`reco tests passed (${lis.length} rows)`);
})().catch((e) => { console.error(e); process.exit(1); });
