const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { JSDOM, VirtualConsole } = require("jsdom");

const root = path.join(__dirname, "..");
const real = "/root/.claude/uploads/9f0b7094-47c7-58f0-bb8e-5a0c55e1425f/06783218-attachment.txt";
const html = fs.existsSync(real)
  ? fs.readFileSync(real, "utf8")
  : `<body><ol><li id="component_discography_item_5" class="component_discography_item"><div class="component_discography_item_exclude">x</div></li></ol></body>`;

(async () => {
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "https://rateyourmusic.com/recommendations/u/release/", virtualConsole: new VirtualConsole() });
  const w = dom.window;
  const made = [];
  const calls = [];
  w.RYMrating = class {
    constructor(...a) { made.push(a); }
    onClick() { calls.push("click"); }
    onMouseMove() { calls.push("move"); }
  };
  w.eval(fs.readFileSync(path.join(root, "reco-ratings.js"), "utf8"));
  const d = w.document;
  const lis = d.querySelectorAll("li.component_discography_item");
  assert.strictEqual(d.querySelectorAll(".rym-reco-rate").length, lis.length);
  const li = lis[0];
  const id = li.id.replace("component_discography_item_", "");
  const wrap = li.querySelector(".rym-reco-rate");
  assert.strictEqual(wrap.nextElementSibling, li.querySelector(".component_discography_item_exclude"), "placed left of the X");
  assert.deepStrictEqual(made[0], ["l", Number(id), 0]);
  assert.ok(d.getElementById(`rating_stars_l_${id}`) && d.getElementById(`rating_num_l_${id}`));
  wrap.querySelector(".my_catalog_rating").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  assert.deepStrictEqual(calls, ["click"]);

  // Missing RYMrating: loads release.js next to the bundle, never throws.
  const dom2 = new JSDOM(`<head><script src="//cdn.sonemic.net/dist/rym25/js/bundle.js?v=1"></script></head><body></body>`, { runScripts: "outside-only", url: "https://rateyourmusic.com/recommendations/u/", virtualConsole: new VirtualConsole() });
  dom2.window.eval(fs.readFileSync(path.join(root, "reco-ratings.js"), "utf8"));
  const added = dom2.window.document.querySelector("script[data-rym-reco-release]");
  assert.ok(added && added.src.includes("/js/page/release.js?v=1"));
  console.log("reco-ratings tests passed");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
