const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { JSDOM, VirtualConsole } = require("jsdom");

const root = path.join(__dirname, "..");
const real = "/root/.claude/uploads/9f0b7094-47c7-58f0-bb8e-5a0c55e1425f/06783218-attachment.txt";
const html = (!process.env.EYM_NO_REAL && fs.existsSync(real))
  ? fs.readFileSync(real, "utf8")
  : `<html><body><ol>${[1, 2, 3].map((n) => `<li id="component_discography_item_${n}" class="component_discography_item"><a class="component_discography_item_link release" href="/release/a/b/${n}/">T</a><div class="component_discography_item_exclude">x</div></li>`).join("")}</ol></body></html>`;

let document_ids;
(async () => {
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "https://rateyourmusic.com/recommendations/u/release/", virtualConsole: new VirtualConsole() });
  const w = dom.window;
  const made = [];
  const calls = [];
  w.IntersectionObserver = class {
    constructor(cb) { this.cb = cb; }
    observe(t) { this.cb([{ isIntersecting: true, target: t }]); }
    unobserve() {}
  };
  const fetched = [];
  w.fetch = async (u) => {
    fetched.push(u);
    const id = (document_ids || []).shift();
    const rating = fetched.length === 1 ? 7 : 0;
    return { ok: true, text: async () => `<script>new RYMrating('l', ${id}, ${rating} );</script>` };
  };
  w.RYMrating = class {
    constructor(...a) { made.push(a); }
    onClick() { calls.push("click"); }
    onMouseMove() { calls.push("move"); }
  };
  const d = w.document;
  document_ids = [...d.querySelectorAll("li.component_discography_item")].map((l) => l.id.replace("component_discography_item_", ""));
  w.__eymGapMs = 0;
  w.eval(fs.readFileSync(path.join(root, "release-data.js"), "utf8"));
  w.eval(fs.readFileSync(path.join(root, "reco-ratings.js"), "utf8"));
  const lis = d.querySelectorAll("li.component_discography_item");
  assert.strictEqual(d.querySelectorAll(".rym-reco-rate").length, lis.length);
  const li = lis[0];
  const id = li.id.replace("component_discography_item_", "");
  const wrap = li.querySelector(".rym-reco-rate");
  assert.strictEqual(wrap.nextElementSibling, li.querySelector(".component_discography_item_exclude"), "placed left of the X");
  assert.strictEqual(JSON.stringify(made[0]), JSON.stringify(["l", Number(id), 0]));
  // saved rating is fetched from the release page and shown
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(fetched.length > 0 && fetched.length <= 3, "at most 3 network requests per load: " + fetched.length);
  assert.strictEqual(JSON.stringify(made.find((a, i) => i > 0 && a[1] === Number(id))), JSON.stringify(["l", Number(id), 7]));
  assert.strictEqual(d.getElementById(`rating_stars_l_${id}`).className, "rating_stars star-7m");
  assert.strictEqual(d.getElementById(`rating_num_l_${id}`).textContent, "3.5");
  assert.ok(d.getElementById(`rating_stars_l_${id}`) && d.getElementById(`rating_num_l_${id}`));
  wrap.querySelector(".my_catalog_rating").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  assert.deepStrictEqual(calls, ["click"]);

  // Missing RYMrating: loads release.js next to the bundle, never throws.
  const dom2 = new JSDOM(`<head><script src="//cdn.sonemic.net/dist/rym25/js/bundle.js?v=1"></script></head><body></body>`, { runScripts: "outside-only", url: "https://rateyourmusic.com/recommendations/u/", virtualConsole: new VirtualConsole() });
  dom2.window.eval(fs.readFileSync(path.join(root, "release-data.js"), "utf8"));
  dom2.window.eval(fs.readFileSync(path.join(root, "reco-ratings.js"), "utf8"));
  const added = dom2.window.document.querySelector("script[data-rym-reco-release]");
  assert.ok(added && added.src.includes("/js/page/release.js?v=1"));
  // rated rows are flagged; the first unrated row is marked and announced
  assert.ok(li.classList.contains("rym-rated") && li.dataset.eymRating === "7");
  if (lis.length > 1) {
    assert.ok(lis[1].hasAttribute("data-eym-first-unrated"), "first unrated marked");
    assert.ok(!lis[1].classList.contains("rym-rated"));
  }
  console.log("reco-ratings tests passed");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
