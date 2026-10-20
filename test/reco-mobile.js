// iOS userscript on the recommendations page at phone width.
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { JSDOM, VirtualConsole } = require("jsdom");

const root = path.join(__dirname, "..");
require("child_process").execFileSync("node", [path.join(root, "build.js")], { stdio: "ignore" });
const src = fs.readFileSync(path.join(root, "dist/userscript/embedyourmusic.user.js"), "utf8");
assert.ok(/@run-at\s+document-start/.test(src));

const real = "/root/.claude/uploads/9f0b7094-47c7-58f0-bb8e-5a0c55e1425f/06783218-attachment.txt";
const html = (!process.env.EYM_NO_REAL && fs.existsSync(real))
  ? fs.readFileSync(real, "utf8")
  : `<html class="page_recommendations"><body><div id="page_sections_recommendations"><ol>${[1, 2, 3]
      .map((n) => `<li id="component_discography_item_${n}" class="component_discography_item"><a class="component_discography_item_image_link" href="/release/a/b/${n}/"></a><div class="component_discography_item_info"><div class="component_discography_item_info_inner"><a class="component_discography_item_link release" href="/release/a/b/${n}/">T${n}</a><a class="artist" href="/artist/b">B</a></div></div></li>`)
      .join("")}</ol></div></body></html>`;

const links = { spotify: { "49JP": { default: true, type: "album" } } };

(async () => {
  const dom = new JSDOM(html, { url: "https://rateyourmusic.com/recommendations/u/release/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: new VirtualConsole() });
  const w = dom.window;
  w.matchMedia = () => ({ matches: true, addEventListener() {}, addListener() {} });
  w.IntersectionObserver = class { constructor(cb) { this.cb = cb; } observe(t) { this.cb([{ isIntersecting: true, target: t }]); } unobserve() {} };
  const order = [];
  w.fetch = async (u) => {
    order.push(u);
    const n = order.length;
    const rating = n <= 2 ? 8 : 0; // first two rows rated, third unrated
    return { ok: true, text: async () => `<div data-links='${JSON.stringify(links)}'></div><script>new RYMrating('l', ID, ${rating} );</script>`.replace("ID", () => idFor(u)) };
  };
  // the page's release href doesn't carry the id, so map hrefs back to row ids
  const rows = [...w.document.querySelectorAll("li.component_discography_item")];
  const idByHref = new Map(rows.map((li) => [li.querySelector("a.component_discography_item_link.release").getAttribute("href"), li.id.replace("component_discography_item_", "")]));
  const idFor = (u) => idByHref.get(u);
  w.__eymGapMs = 0;
  w.eval(src);

  const d = w.document;
  const tick = (ms = 80) => new Promise((r) => setTimeout(r, ms));
  await tick(200);

  assert.ok(d.getElementById("page_sections_recommendations").classList.contains("rym-reco-mobile"));
  assert.ok(!d.getElementById("rym-reco-player"), "no side panel on phones");
  assert.ok(rows[0].classList.contains("rym-rated") && rows[1].classList.contains("rym-rated"), "rated rows flagged");
  assert.ok(rows[2].hasAttribute("data-eym-first-unrated"), "first unrated found");
  assert.strictEqual(rows[2].nextElementSibling, d.querySelector("li.rym-reco-inline"), "player opens under the first unrated row");
  assert.ok(d.querySelector("li.rym-reco-inline iframe[src*='open.spotify.com/embed/album/49JP']"));
  assert.ok(!d.querySelector(".rym-tracks"), "no track saving in the userscript");
  assert.ok(d.documentElement.classList.contains("eym-ready"), "page revealed");

  // tapping another cover moves the player; tapping it again closes it
  const art = (li) => li.querySelector("a.component_discography_item_image_link");
  art(rows[0]).dispatchEvent(new w.MouseEvent("click", { bubbles: true, cancelable: true }));
  await tick();
  assert.strictEqual(rows[0].nextElementSibling, d.querySelector("li.rym-reco-inline"));
  art(rows[0]).dispatchEvent(new w.MouseEvent("click", { bubbles: true, cancelable: true }));
  assert.ok(d.querySelector("li.rym-reco-inline").hidden);
  console.log("reco mobile tests passed");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
