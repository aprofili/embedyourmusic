// Hero layout test on a mock release page shaped like RYM's real markup.
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { JSDOM } = require("jsdom");

const root = path.join(__dirname, "..");
const css = fs.readFileSync(path.join(root, "content.css"), "utf8");
const js = fs.readFileSync(path.join(root, "content.js"), "utf8");

const html = `<!doctype html><html><head><style>${css}</style></head><body>
<div class="release_page">
  <div id="agg"></div>
  <meta itemprop="name" content="x" />
  <div id="wrapper" style="max-width:1700px"><div class="row">
    <div id="column_container_right" class="large-8 push-4 columns release_right_column">
      <div class="section_main_info section_outer" id="maininfo">info</div>
      <div class="hide-for-small"><div class="section_outer section_issues" id="issues">issues</div></div>
      <div class="section_outer section_reviews" id="reviews">reviews</div>
    </div>
    <div id="column_container_left" class="large-4 pull-8 columns release_left_column">
      <div class="page_release_art_frame" id="frame">
        <div class="hide-for-small" id="frameinner">
          <a href="buy/" id="art"><div class="coverart_1"><img src="x.jpg"></div></a>
          <div id="media_link_button_container_top" class="media_link_container">
            <a id="splink" href="https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy">spotify</a>
          </div>
          <div id="submit">Submit media links</div>
        </div>
      </div>
      <table class="color_bar"><tr><td>.</td></tr></table>
      <div class="hide-for-small"><div class="section_tracklisting" id="tracklist">tracks</div></div>
      <div class="section_comments" id="comments">comments</div>
      <a name="suggestions" class="anchor"></a>
      <div class="section_suggestions" id="suggestions"><ul class="suggestions" id="sugglist"><li>one</li><li>two</li></ul></div>
      <div class="column_filler" id="column_filler_left"></div>
    </div>
  </div></div>
  <div id="contrib">Contributions</div>
</div>
</body></html>`;

function load() {
  const dom = new JSDOM(html, { runScripts: "outside-only", pretendToBeVisual: true });
  const { window } = dom;
  window.IntersectionObserver = class { observe() {} unobserve() {} };
  window.chrome = { runtime: { sendMessage: async () => ({}) } };
  window.eval(js);
  return window;
}

const window = load();
const { document } = window;
const $ = (s) => document.querySelector(s);

const hero = $(".rym-hero");
assert.ok(hero, "hero created");
assert.strictEqual(hero.tagName, "SECTION");
assert.strictEqual(hero.nextElementSibling.id, "wrapper", "hero sits just above the normal layout");

const heroArt = hero.querySelector(".rym-hero-art");
const heroMain = hero.querySelector(".rym-hero-main");
assert.strictEqual(heroArt.firstElementChild.id, "art", "art on the left");
assert.ok(heroMain.querySelector("#media_link_button_container_top"), "player container on the right");
assert.ok(heroMain.querySelector("#submit"), "submit link moved with it");
assert.ok(heroMain.querySelector("#suggestions"), "suggestions on the right");
assert.ok(heroMain.querySelector(".rym-embed"), "our embed lands inside the hero");

// Suggestions toggle moved with it and sits directly above it
const sug = $("#suggestions");
assert.ok(sug.previousElementSibling.classList.contains("rym-collapse-toggle"));
assert.ok(heroMain.contains(sug.previousElementSibling));

// Embed comes after player container, before suggestions
const order = [...heroMain.querySelectorAll("#media_link_button_container_top, .rym-embed, #suggestions")].map((n) => n.id || "embed");
assert.deepStrictEqual(order, ["media_link_button_container_top", "embed", "suggestions"]);

// Old art frame is hidden; the rest of the page is untouched
assert.strictEqual(window.getComputedStyle($("#frame")).display, "none");
assert.ok($("#tracklist"), "tracklist still in place");
assert.ok($("#column_container_left").contains($("#tracklist")));
assert.ok($("#column_container_right").contains($("#reviews")));
assert.ok(!$("#column_container_left").contains(sug), "suggestions left the left column");

// Contributions is still the third div under .release_page
assert.strictEqual($(".release_page > div:nth-of-type(3)").id, "contrib");

// Two-column suggestions style is present
assert.ok(css.includes("column-count: 2"));

// Idempotent
window.__embedYourMusic.run();
assert.strictEqual(document.querySelectorAll(".rym-hero").length, 1);
assert.strictEqual(document.querySelectorAll(".rym-embed").length, 1);

// Narrow screens: leave the page alone
const dom2 = new JSDOM(html, { runScripts: "outside-only", pretendToBeVisual: true });
dom2.window.matchMedia = () => ({ matches: false });
dom2.window.IntersectionObserver = class { observe() {} unobserve() {} };
dom2.window.chrome = { runtime: { sendMessage: async () => ({}) } };
dom2.window.eval(js);
assert.ok(!dom2.window.document.querySelector(".rym-hero"), "no hero on small screens");

console.log("hero tests passed");
